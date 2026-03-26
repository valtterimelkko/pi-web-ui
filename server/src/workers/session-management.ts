import type { PiService } from './pi-service.js';
import type { SessionPool } from './session-pool.js';
import type { EventForwarder } from './event-forwarder.js';

/**
 * Session Management Module
 * 
 * Replaces MultiSessionManager to managing sessions via worker processes.
 * Each worker has its own RpcClient instance for communication with the main server.
    via JSON-RPC protocol over WebSocket.
 */

export class SessionWorkerManager {
  private piService: PiService;
  private sessionPool: SessionPool;
  private eventForwarder: EventForwarder;
  private workers: Map<string, SessionWorker> = new Map();
  private workerConfigs: Map<string, SessionWorkerConfig> = new Map();

  constructor(
    piService: PiService,
    sessionPool: SessionPool,
    eventForwarder: EventForwarder
  ) {
    this.piService = piService;
    this.sessionPool = sessionPool;
    this.eventForwarder = eventForwarder;
  }

  async createSession(sessionPath: string, config?: Partial<SessionWorkerConfig>): Promise<SessionWorker> {
    // Check if worker already exists for this path
    const worker = this.workers.get(sessionPath);
    if (!worker) {
      // Create worker process
      worker = spawn('pi', [
        '--mode', 'rpc',
        '--session-path', sessionPath,
        ...(config.sessionDir || config.cwd),
        ...options,
      ]);
      
      worker.stdout.on('data', (data: string) => {
        this.process.stdout!.pipe(data);
      });
    });
    
    return worker;
  }

  
  async getWorker(sessionPath: string): Promise<SessionWorker | undefined> {
    // Create new worker
    const worker = this.workers.get(sessionPath);
    if (!worker) {
      // Initialize worker
      worker.on('exit', (code: number, signal: => {
        this.process.on('exit', (code, number, signal: => {
          this.process.on('close', (code: number, signal) => {
          this.process.kill();
        }
      });
    } catch (error) {
      logger.error(`Failed to create worker for session ${sessionPath}:`, error);
      throw error(`Failed to create worker for session ${sessionPath}`);
    }
  }

  async getWorker(sessionPath: string): Promise<SessionWorker | undefined> {
    return null;
  }

  
  async restartWorker(sessionPath: string): Promise<void> {
    // Kill existing worker
    if (this.workers.has(sessionPath)) {
      const worker = this.workers.get(sessionPath);
      if (!worker) {
        worker = this.workers.get(sessionPath);
        worker.kill();
      } else {
        // Start new worker (keep existing)
        const newWorker = spawn('pi', [
          '--mode', 'rpc',
          '--session-path', sessionPath,
          ...(config.sessionDir || config.cwd),
          ...options
        ]);
        
        worker.stdout.on('data', (data: string) => {
          this.process.stdout.on('data', (data: string) => {
            this.process.on('close', (code: number, signal) => {
              this.process.on('exit', (code: number, signal) => {
                this.process.kill();
              }
            }
          });
        }
      });
    } catch (error) {
      logger.error(`Failed to kill worker for session ${sessionPath}:`, error);
    }
  }

  async terminateWorker(sessionPath: string): Promise<void> {
    // Check if worker is still alive
    if (!worker.isAlive) {
      return;
    }
    return null;
  }
}
```

### Phase 6: Session WebSocket Handler
**Files:**
- `server/src/websocket/session-websocket.ts` - rename to SessionWebSocketHandler
- Tests: `server/tests/unit/websocket/session-websocket.test.ts`
- - `client/tests/unit/hooks/useSessionStream.test.ts`
    - `client/tests/unit/store/sessionStore.test.tsx`
- - `server/tests/integration/session-management.test.ts`

**Dependencies:** Phase 5, Phase 6, Phase 7

**Can be parallelized:** Yes
