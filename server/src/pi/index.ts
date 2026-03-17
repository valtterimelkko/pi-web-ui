export { PiService, getPiService, initializePiService, type CreateSessionOptions } from './pi-service.js';
export { SessionPool, type ClientSession } from './session-pool.js';
export { EventForwarder, type WebSocketSender, type ForwardedEvent, type SessionEvent } from './event-forwarder.js';
export { SessionWatcher, getSessionWatcher, startSessionWatcher, stopSessionWatcher } from './session-watcher.js';
export type { SessionChangeEvent, SessionInfo } from './session-watcher.js';
export {
  createWebUIContext,
  createCommandContextActions,
  type WebUIContext,
  type CommandActionContext,
} from './extension-ui-adapter.js';
export {
  ExtensionUIHandler,
  getExtensionUIHandler,
  type ExtensionUIRequest,
  type ExtensionUIResponse,
} from './extension-ui-handler.js';
