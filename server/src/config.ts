import dotenv from 'dotenv';
import path from 'path';
import os from 'os';

dotenv.config();

export interface ServerConfig {
  port: number;
  nodeEnv: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  allowedOrigins: string[];
  authPassword: string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  piAgentDir: string;
  sessionDir: string | undefined;
  claudeSessionDir: string;
  sessionRegistryPath: string;
  maxClaudeProcesses: number;
  opencodeServerPort: number;
  opencodeServerHost: string;
  opencodeServerPassword: string;
  opencodeServerEnabled: boolean;
  opencodeWorkingDir: string;
  opencodeMaxSessions: number;
  opencodeIdleTimeoutMs: number;
  opencodeStaleStreamingMs: number;
  opencodeMaxPinnedSessions: number;
  opencodeCleanupIntervalMs: number;
  opencodeDebugRawEvents: boolean;
  opencodeTrustedPermissions: boolean;
  opencodePermissionApproveMode: 'once' | 'always';
  opencodeServerMaxUptimeMs: number;
  opencodeModelProviders: string;
  opencodeModelSnapshotPath: string;
  internalApiEnabled: boolean;
  internalApiSocketPath: string;
  internalApiKey: string;
  internalApiTokenPath: string;
  dictationOpenaiApiKey: string;
  dictationVocabularyDbPath: string;
  ttsOpenaiApiKey: string;
  ttsModel: string;
  claudeChannelEnabled: boolean;
  claudeChannelPluginDir: string;
  claudeChannelWsPort: number;
  claudeChannelHookPort: number;
  piStaleStreamingMs: number;
  antigravityEnabled: boolean;
  antigravitySessionDir: string;
  antigravityDefaultModel: string;
  antigravityPromptTimeoutMs: number;
  antigravityIdleTimeoutMs: number;
  antigravityMaxSessions: number;
  antigravityMaxPinnedSessions: number;
  antigravityCleanupIntervalMs: number;
}

function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const isProduction = process.env.NODE_ENV === 'production';

export const config: ServerConfig = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  jwtSecret: isProduction 
    ? getRequiredEnvVar('JWT_SECRET')
    : (process.env.JWT_SECRET || 'dev-secret-change-in-production'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
  allowedOrigins: process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['http://localhost:5173', 'http://localhost:3000'],
  authPassword: isProduction
    ? getRequiredEnvVar('AUTH_PASSWORD')
    : (process.env.AUTH_PASSWORD || 'dev-password'),
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 minutes
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  piAgentDir: process.env.PI_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'),
  sessionDir: process.env.SESSION_DIR || undefined,
  claudeSessionDir: process.env.CLAUDE_SESSION_DIR || path.join(os.homedir(), '.pi-web-ui', 'claude-sessions'),
  sessionRegistryPath: process.env.SESSION_REGISTRY_PATH || path.join(os.homedir(), '.pi-web-ui', 'session-registry.json'),
  maxClaudeProcesses: parseInt(process.env.MAX_CLAUDE_PROCESSES || '10', 10),
  opencodeServerPort: parseInt(process.env.OPENCODE_SERVER_PORT || '4096', 10),
  opencodeServerHost: process.env.OPENCODE_SERVER_HOST || '127.0.0.1',
  opencodeServerPassword: process.env.OPENCODE_SERVER_PASSWORD || '',
  opencodeServerEnabled: process.env.OPENCODE_ENABLED !== 'false',
  opencodeWorkingDir: process.env.OPENCODE_WORKING_DIR || process.cwd(),
  opencodeMaxSessions: parseInt(process.env.OPENCODE_MAX_SESSIONS || '4', 10),
  opencodeIdleTimeoutMs: parseInt(process.env.OPENCODE_IDLE_TIMEOUT_MS || '1800000', 10),
  opencodeStaleStreamingMs: parseInt(process.env.OPENCODE_STALE_STREAMING_MS || '900000', 10),
  opencodeMaxPinnedSessions: parseInt(process.env.OPENCODE_MAX_PINNED_SESSIONS || '2', 10),
  opencodeCleanupIntervalMs: parseInt(process.env.OPENCODE_CLEANUP_INTERVAL_MS || '60000', 10),
  opencodeDebugRawEvents: process.env.OPENCODE_DEBUG_RAW_EVENTS === 'true',
  opencodeTrustedPermissions: process.env.OPENCODE_TRUSTED_PERMISSIONS === 'true',
  opencodePermissionApproveMode: process.env.OPENCODE_PERMISSION_APPROVE_MODE === 'once' ? 'once' : 'always',
  opencodeServerMaxUptimeMs: parseInt(process.env.OPENCODE_SERVER_MAX_UPTIME_MS || '86400000', 10),
  // Which OpenCode providers' models are surfaced in the web UI model picker.
  // Comma-separated provider ids (e.g. "zai-coding-plan,kilo,opencode"), or
  // "all"/"*" to expose every provider OpenCode reports. API keys never leave
  // OpenCode's own auth storage — Pi Web UI only reads /config/providers.
  opencodeModelProviders: (process.env.OPENCODE_MODEL_PROVIDERS?.trim() || 'zai-coding-plan,kilo,opencode'),
  // Host-side audit snapshot for the weekly model-refresh job (ids only, no secrets).
  opencodeModelSnapshotPath: process.env.OPENCODE_MODEL_SNAPSHOT_PATH || path.join(os.homedir(), '.pi-web-ui', 'opencode-model-snapshot.json'),
  internalApiEnabled: process.env.INTERNAL_API_ENABLED !== 'false',
  internalApiSocketPath: process.env.INTERNAL_API_SOCKET_PATH || path.join(os.homedir(), '.pi-web-ui', 'internal-api.sock'),
  internalApiKey: process.env.INTERNAL_API_KEY || '',
  internalApiTokenPath: process.env.INTERNAL_API_TOKEN_PATH || path.join(os.homedir(), '.pi-web-ui', 'internal-api-token'),
  dictationOpenaiApiKey: process.env.OPENAI_API_KEY || process.env.DICTATION_OPENAI_API_KEY || '',
  dictationVocabularyDbPath: process.env.DICTATION_VOCABULARY_DB_PATH || '/root/voicenotebot/streaming-dictation/backend/data/transcripts.db',
  ttsOpenaiApiKey: process.env.OPENAI_API_KEY || process.env.TTS_OPENAI_API_KEY || process.env.DICTATION_OPENAI_API_KEY || '',
  ttsModel: process.env.TTS_MODEL || 'tts-1',
  claudeChannelEnabled: process.env.CLAUDE_CHANNEL_ENABLED === 'true',
  claudeChannelPluginDir: process.env.CLAUDE_CHANNEL_PLUGIN_DIR ?? path.resolve(process.cwd(), 'pi-claude-channel'),
  claudeChannelWsPort: parseInt(process.env.CLAUDE_CHANNEL_WS_PORT || '3100', 10),
  claudeChannelHookPort: parseInt(process.env.CLAUDE_CHANNEL_HOOK_PORT || '3101', 10),
  piStaleStreamingMs: parseInt(process.env.PI_STALE_STREAMING_MS || '900000', 10),
  antigravityEnabled: process.env.ANTIGRAVITY_ENABLED !== 'false',
  antigravitySessionDir: process.env.ANTIGRAVITY_SESSION_DIR || path.join(os.homedir(), '.pi-web-ui', 'antigravity-sessions'),
  antigravityDefaultModel: process.env.ANTIGRAVITY_DEFAULT_MODEL || 'Gemini 3.5 Flash (Medium)',
  antigravityPromptTimeoutMs: parseInt(process.env.ANTIGRAVITY_PROMPT_TIMEOUT_MS || '600000', 10),
  antigravityIdleTimeoutMs: parseInt(process.env.ANTIGRAVITY_IDLE_TIMEOUT_MS || '1800000', 10),
  antigravityMaxSessions: parseInt(process.env.ANTIGRAVITY_MAX_SESSIONS || '4', 10),
  antigravityMaxPinnedSessions: parseInt(process.env.ANTIGRAVITY_MAX_PINNED_SESSIONS || '2', 10),
  antigravityCleanupIntervalMs: parseInt(process.env.ANTIGRAVITY_CLEANUP_INTERVAL_MS || '60000', 10),
};
