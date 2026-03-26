/**
 * Initialize Method Handler
 * Handles the JSON-RPC 'initialize' method for capability negotiation
 */

import type { MethodHandler } from './types.js';
import type {
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
} from './types.js';

/**
 * Current protocol version
 */
export const PROTOCOL_VERSION = '1.0.0';

/**
 * Server name
 */
export const SERVER_NAME = 'pi-web-ui';

/**
 * Server version (from package.json at build time)
 */
export const SERVER_VERSION = process.env.npm_package_version ?? '1.0.0';

/**
 * Default server capabilities
 */
export const DEFAULT_CAPABILITIES: ServerCapabilities = {
  protocolVersion: PROTOCOL_VERSION,
  name: SERVER_NAME,
  version: SERVER_VERSION,
  features: {
    streaming: true,
    steering: true,
    planMode: true,
    replay: true,
    multiSession: true,
    thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  },
};

/**
 * Initialize method handler
 * 
 * Negotiates capabilities between client and server, returns session ID
 * and server capabilities.
 * 
 * @param params - Initialize parameters with optional protocol version and client capabilities
 * @param context - Method execution context
 * @returns Initialize result with session ID and server capabilities
 */
export const initialize: MethodHandler<InitializeParams, InitializeResult> = async (
  params: InitializeParams,
  context
): Promise<InitializeResult> => {
  const { sessionId } = context;

  // Log client capabilities if provided
  if (params.capabilities) {
    console.log(`[initialize] Client capabilities:`, {
      name: params.capabilities.name,
      version: params.capabilities.version,
      features: params.capabilities.features,
    });
  }

  // Check protocol version compatibility
  const clientVersion = params.protocolVersion;
  if (clientVersion && clientVersion !== PROTOCOL_VERSION) {
    console.log(
      `[initialize] Client requested protocol version ${clientVersion}, server has ${PROTOCOL_VERSION}`
    );
    // For now, we accept any version and return our version
    // In the future, we might implement version negotiation
  }

  // Return session ID and server capabilities
  return {
    sessionId,
    capabilities: DEFAULT_CAPABILITIES,
    protocolVersion: PROTOCOL_VERSION,
  };
};

export default initialize;
