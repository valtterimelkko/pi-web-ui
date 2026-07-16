import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import dotenv from 'dotenv';

interface ValidationIsolationInput {
  validationDir: string;
  port: string;
  claudeWsPort: string;
  claudeHookPort: string;
  opencodePort: string;
}

export function buildValidationIsolationEnv(
  input: ValidationIsolationInput,
): NodeJS.ProcessEnv {
  const piSessionsDir = join(input.validationDir, 'pi-sessions');

  return {
    PI_WEB_UI_VALIDATION_MODE: 'true',
    PORT: input.port,
    INTERNAL_API_ENABLED: 'true',
    INTERNAL_API_SOCKET_PATH: join(input.validationDir, 'internal-api.sock'),
    INTERNAL_API_TOKEN_PATH: join(input.validationDir, 'internal-api-token'),
    INTERNAL_API_WATCH_DIR: join(input.validationDir, 'watches'),
    INTERNAL_API_RUN_RECEIPTS_DIR: join(input.validationDir, 'run-receipts'),
    NOTIFICATIONS_DIR: join(input.validationDir, 'notifications'),
    INTERNAL_API_PIN_DIR: join(input.validationDir, 'pins'),
    SESSION_REGISTRY_PATH: join(input.validationDir, 'session-registry.json'),
    SESSION_DIR: piSessionsDir,
    PI_SESSIONS_DIR: piSessionsDir,
    CLAUDE_SESSION_DIR: join(input.validationDir, 'claude-sessions'),
    ANTIGRAVITY_SESSION_DIR: join(input.validationDir, 'antigravity-sessions'),
    CLAUDE_CHANNEL_WS_PORT: input.claudeWsPort,
    CLAUDE_CHANNEL_HOOK_PORT: input.claudeHookPort,
    OPENCODE_SERVER_HOST: '127.0.0.1',
    OPENCODE_SERVER_PORT: input.opencodePort,
    OPENCODE_WORKING_DIR: join(input.validationDir, 'opencode-workspace'),
  };
}

export function resolveValidationEnvFile(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const flagIndex = argv.indexOf('--env-file');
  if (flagIndex >= 0) {
    const value = argv[flagIndex + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('--env-file requires a path.');
    }
    return value;
  }

  return env.PI_WEB_UI_VALIDATION_ENV_FILE?.trim() || undefined;
}

export function resolveValidationEnvKeys(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const flagValues: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--env-key') continue;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('--env-key requires an environment variable name.');
    }
    flagValues.push(value);
    i += 1;
  }

  const values = flagValues.length > 0
    ? flagValues
    : (env.PI_WEB_UI_VALIDATION_ENV_KEYS ?? '').split(',');
  const keys = values.map((value) => value.trim()).filter(Boolean);

  for (const key of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid validation environment key '${key}'.`);
    }
  }

  return [...new Set(keys)];
}

export function loadValidationEnvFile(
  filePath: string,
  keys: string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (keys.length === 0) {
    throw new Error('Loading a validation env file requires at least one --env-key allowlist entry.');
  }

  let parsed: Record<string, string>;
  try {
    parsed = dotenv.parse(readFileSync(filePath));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to load validation env file '${filePath}': ${reason}`);
  }

  for (const key of keys) {
    const value = parsed[key];
    if (!value?.trim()) {
      throw new Error(`Validation env file '${filePath}' does not define requested key '${key}'.`);
    }
    if (!(key in env)) env[key] = value;
  }
}
