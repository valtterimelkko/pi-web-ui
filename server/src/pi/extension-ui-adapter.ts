import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionCommandContextActions,
} from '@mariozechner/pi-coding-agent';
import type { ExtensionUIRequest, ExtensionUIResponse } from './extension-ui-handler.js';
import { getExtensionUIHandler } from './extension-ui-handler.js';

export interface WebUIContext {
  sendToClient(message: unknown): void;
  clientId: string;
}

export interface CommandActionContext {
  clientId: string;
  sessionId: string;
  piService: {
    removeClient(clientId: string): void;
    cleanup(): Promise<void>;
  };
  sessionPool: {
    createClientSession(clientId: string, options?: { cwd?: string }): Promise<{
      sessionId: string;
      session: { sessionFile?: string };
    }>;
    switchClientSession(clientId: string, sessionPath: string): Promise<{
      sessionId: string;
      session: { sessionFile?: string };
    }>;
    removeClient(clientId: string): void;
  };
  getSessionManager: () => unknown;
}

/**
 * Generate a unique ID for UI requests
 */
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Creates a Web UI context that implements the ExtensionUIContext interface
 * by forwarding UI requests to the WebSocket client.
 */
export function createWebUIContext(webUI: WebUIContext): ExtensionUIContext {
  const handler = getExtensionUIHandler();
  
  // UI context created for client

  return {
    // Show a selector and return the user's choice
    async select(
      title: string,
      options: string[],
      opts?: ExtensionUIDialogOptions
    ): Promise<string | undefined> {
      const request: ExtensionUIRequest = {
        id: generateRequestId(),
        type: 'select',
        method: 'select',
        params: {
          title,
          message: title,
          options: options.map((label, index) => ({
            label,
            value: label,
            index,
          })),
        },
        timeout: opts?.timeout || 30000,
      };

      const response = await handler.handleRequest(request, webUI.sendToClient);
      
      if (response.cancelled || response.approved === false) {
        return undefined;
      }
      return response.value as string | undefined;
    },

    // Show a confirmation dialog
    async confirm(
      title: string,
      message: string,
      opts?: ExtensionUIDialogOptions
    ): Promise<boolean> {
      const request: ExtensionUIRequest = {
        id: generateRequestId(),
        type: 'confirm',
        method: 'confirm',
        params: {
          title,
          message,
        },
        timeout: opts?.timeout || 30000,
      };

      const response = await handler.handleRequest(request, webUI.sendToClient);
      
      if (response.cancelled) {
        return false;
      }
      return response.approved === true;
    },

    // Show a text input dialog
    async input(
      title: string,
      placeholder?: string,
      opts?: ExtensionUIDialogOptions
    ): Promise<string | undefined> {
      const request: ExtensionUIRequest = {
        id: generateRequestId(),
        type: 'input',
        method: 'input',
        params: {
          title,
          label: title,
          placeholder,
        },
        timeout: opts?.timeout || 30000,
      };

      const response = await handler.handleRequest(request, webUI.sendToClient);
      
      if (response.cancelled || response.approved === false) {
        return undefined;
      }
      return response.value as string | undefined;
    },

    // Show a notification to the user
    notify(message: string, type: 'info' | 'warning' | 'error' = 'info'): void {
      webUI.sendToClient({
        type: 'notification',
        notification: {
          message,
          type,
          timestamp: Date.now(),
        },
      });
    },

    // Listen to raw terminal input - not applicable for Web UI
    onTerminalInput() {
      // Web UI doesn't support raw terminal input
      // Return no-op unsubscribe
      return () => {};
    },

    // Set status text in the footer/status bar
    setStatus(key: string, text: string | undefined): void {
      webUI.sendToClient({
        type: 'extension_status',
        status: {
          key,
          text,
        },
      });
    },

    // Set the working/loading message
    setWorkingMessage(message?: string): void {
      webUI.sendToClient({
        type: 'working_message',
        message,
      });
    },

    // Set a widget - not fully supported in Web UI, sent as notification
    setWidget(
      key: string,
      content: string[] | unknown | undefined,
      _options?: { placement?: 'aboveEditor' | 'belowEditor' }
    ): void {
      if (content === undefined) {
        webUI.sendToClient({
          type: 'widget_cleared',
          key,
        });
      } else if (Array.isArray(content)) {
        webUI.sendToClient({
          type: 'widget_content',
          key,
          content,
        });
      }
    },

    // Set a custom footer component - not supported in Web UI
    setFooter(): void {
      // Not supported in Web UI mode
    },

    // Set a custom header component - not supported in Web UI
    setHeader(): void {
      // Not supported in Web UI mode
    },

    // Set the terminal window/tab title - updates document title on client
    setTitle(title: string): void {
      webUI.sendToClient({
        type: 'set_title',
        title,
      });
    },

    // Show a custom component - not fully supported, falls back to notification
    async custom<T>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _factory: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _options?: any
    ): Promise<T> {
      // Custom components are not supported in Web UI mode
      // Extensions should use the standard UI primitives instead
      throw new Error('Custom UI components are not supported in Web UI mode');
    },

    // Paste text into the editor - sends to client as editor update
    pasteToEditor(text: string): void {
      webUI.sendToClient({
        type: 'paste_to_editor',
        text,
      });
    },

    // Set the text in the core input editor
    setEditorText(text: string): void {
      webUI.sendToClient({
        type: 'set_editor_text',
        text,
      });
    },

    // Get the current text from the core input editor
    getEditorText(): string {
      // This is synchronous but we can't get real-time editor state from Web UI
      // Return empty string - extensions should use input() for getting user input
      return '';
    },

    // Show a multi-line editor for text editing
    async editor(title: string, prefill?: string): Promise<string | undefined> {
      const request: ExtensionUIRequest = {
        id: generateRequestId(),
        type: 'editor',
        method: 'editor',
        params: {
          title,
          label: title,
          defaultValue: prefill || '',
        },
        timeout: 30000,
      };

      const response = await handler.handleRequest(request, webUI.sendToClient);
      
      if (response.cancelled || response.approved === false) {
        return undefined;
      }
      return response.value as string | undefined;
    },

    // Set a custom editor component - not supported in Web UI
    setEditorComponent(): void {
      // Not supported in Web UI mode
    },

    // Get the current theme - returns undefined as Web UI manages its own theming
    get theme() {
      // Web UI manages its own theme
      // Return a minimal theme object
      return {
        name: 'web-ui',
        colors: {},
      } as unknown as import('@mariozechner/pi-coding-agent').Theme;
    },

    // Get all available themes
    getAllThemes() {
      return [];
    },

    // Get a theme by name
    getTheme() {
      return undefined;
    },

    // Set the current theme - sends to client
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setTheme(theme: any): { success: boolean; error?: string } {
      const themeName = typeof theme === 'string' ? theme : theme?.name;
      webUI.sendToClient({
        type: 'set_theme',
        theme: themeName ?? 'default',
      });
      return { success: true };
    },

    // Get current tool output expansion state - Web UI manages this
    getToolsExpanded(): boolean {
      return true; // Default to expanded in Web UI
    },

    // Set tool output expansion state - not applicable to Web UI
    setToolsExpanded(_expanded: boolean): void {
      // Web UI manages expansion state independently
    },
  };
}

/**
 * Creates command context actions for extension commands
 * that need to control session lifecycle.
 */
export function createCommandContextActions(
  ctx: CommandActionContext
): ExtensionCommandContextActions {
  return {
    // Wait for the agent to finish streaming
    async waitForIdle(): Promise<void> {
      // The agent idle state is managed by the session
      // We'll poll briefly to check if agent becomes idle
      const maxWaitTime = 60000; // 1 minute max wait
      const pollInterval = 100;
      let waited = 0;

      while (waited < maxWaitTime) {
        // Get the session and check if agent is idle
        const session = ctx.getSessionManager();
        if (!session || (session as { isIdle?: () => boolean }).isIdle?.()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        waited += pollInterval;
      }

      throw new Error('Timeout waiting for agent to become idle');
    },

    // Start a new session
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async newSession(options?: any): Promise<{ cancelled: boolean }> {
      try {
        // Create a new client session
        const clientSession = await ctx.sessionPool.createClientSession(ctx.clientId, {
          cwd: process.cwd(),
        });

        // If there's a setup function, call it
        if (options?.setup) {
          await options.setup(clientSession.session);
        }

        return { cancelled: false };
      } catch (error) {
        console.error('Error creating new session:', error);
        return { cancelled: true };
      }
    },

    // Fork from a specific entry
    async fork(entryId: string): Promise<{ cancelled: boolean }> {
      // Forking will be implemented when the SDK supports it
      console.warn('Fork not yet implemented in Web UI, entryId:', entryId);
      return { cancelled: true };
    },

    // Navigate to a different point in the session tree
    async navigateTree(
      targetId: string,
      options?: {
        summarize?: boolean;
        customInstructions?: string;
        replaceInstructions?: boolean;
        label?: string;
      }
    ): Promise<{ cancelled: boolean }> {
      // Tree navigation will be implemented when the SDK supports it
      console.warn('Tree navigation not yet implemented in Web UI, targetId:', targetId, options);
      return { cancelled: true };
    },

    // Switch to a different session file
    async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
      try {
        await ctx.sessionPool.switchClientSession(ctx.clientId, sessionPath);
        return { cancelled: false };
      } catch (error) {
        console.error('Error switching session:', error);
        return { cancelled: true };
      }
    },

    // Reload extensions, skills, prompts, and themes
    async reload(): Promise<void> {
      // Trigger a reload by notifying the client
      // The actual reload happens on the next session creation
      ctx.piService.removeClient(ctx.clientId);
    },
  };
}
