import { EventEmitter } from 'events';

export interface ExtensionUIRequest {
  id: string;
  type: 'confirm' | 'select' | 'input' | 'editor';
  method: string;
  params: Record<string, unknown>;
  timeout: number;
}

export interface ExtensionUIResponse {
  id: string;
  approved?: boolean;
  value?: unknown;
  cancelled?: boolean;
}

export class ExtensionUIHandler extends EventEmitter {
  private pendingRequests: Map<string, {
    resolve: (value: ExtensionUIResponse) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = new Map();
  private defaultTimeout = 30000; // 30 seconds

  /**
   * Handle incoming extension_ui_request from Pi SDK
   */
  async handleRequest(
    request: ExtensionUIRequest,
    sendToClient: (message: unknown) => void
  ): Promise<ExtensionUIResponse> {
    return new Promise((resolve, reject) => {
      // Set timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new Error(`Extension UI request timed out: ${request.type}`));
      }, request.timeout || this.defaultTimeout);

      // Store pending request
      this.pendingRequests.set(request.id, { resolve, reject, timeout });

      // Forward to WebSocket client
      sendToClient({
        type: 'extension_ui_request',
        request,
      });

      this.emit('request_sent', request);
    });
  }

  /**
   * Handle response from WebSocket client
   */
  handleResponse(response: ExtensionUIResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      console.warn(`No pending request for ID: ${response.id}`);
      return;
    }

    // Clear timeout
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);

    // Resolve with response
    pending.resolve(response);
    this.emit('request_resolved', response);
  }

  /**
   * Cancel all pending requests
   */
  cancelAll(): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.resolve({ id, cancelled: true });
    }
    this.pendingRequests.clear();
  }

  /**
   * Get pending request count
   */
  getPendingCount(): number {
    return this.pendingRequests.size;
  }
}

// Singleton instance
let handler: ExtensionUIHandler | null = null;

export function getExtensionUIHandler(): ExtensionUIHandler {
  if (!handler) {
    handler = new ExtensionUIHandler();
  }
  return handler;
}
