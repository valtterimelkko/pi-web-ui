import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import dotenv from 'dotenv';

interface ValidationIsolationInput {
  validationDir: string;
  port: string;
  claudeWsPort: string;
  claudeHookPort: string;
  opencodePort: string;
  commandCodeFixture?: boolean;
  commandCodeBrowserFixture?: boolean;
}

export function buildValidationIsolationEnv(
  input: ValidationIsolationInput,
): NodeJS.ProcessEnv {
  const piSessionsDir = join(input.validationDir, 'pi-sessions');
  const commandCodeFixture = input.commandCodeFixture === true;
  const commandCodeBrowserFixture = input.commandCodeBrowserFixture === true;
  if (commandCodeBrowserFixture && !commandCodeFixture) {
    throw new Error('Command Code browser fixture requires the Command Code fixture executable.');
  }

  return {
    PI_WEB_UI_VALIDATION_MODE: 'true',
    PI_WEB_UI_VALIDATION_DEFAULT_CWD: join(input.validationDir, 'workspace'),
    PORT: input.port,
    INTERNAL_API_ENABLED: 'true',
    // Never inherit a production static key; force the disposable server to
    // create and use its isolated token file instead.
    INTERNAL_API_KEY: '',
    INTERNAL_API_SOCKET_PATH: join(input.validationDir, 'internal-api.sock'),
    INTERNAL_API_TOKEN_PATH: join(input.validationDir, 'internal-api-token'),
    INTERNAL_API_WATCH_DIR: join(input.validationDir, 'watches'),
    INTERNAL_API_RUN_RECEIPTS_DIR: join(input.validationDir, 'run-receipts'),
    NOTIFICATIONS_DIR: join(input.validationDir, 'notifications'),
    INTERNAL_API_PIN_DIR: join(input.validationDir, 'pins'),
    // Command Code is excluded from the normal disposable all-runtime matrix;
    // the explicit fixture mode below is deterministic and provider-free.
    // Browser fixture validation intentionally keeps the Internal API shadow
    // gate separate; it is exercised through the authenticated WebSocket path.
    PI_INTERNAL_API_COMMANDCODE_ENABLED: commandCodeFixture && !commandCodeBrowserFixture ? 'true' : 'false',
    PI_COMMAND_CODE_BROWSER_ENABLED: commandCodeBrowserFixture ? 'true' : 'false',
    PI_COMMAND_CODE_BROWSER_ALLOWED_MODELS: commandCodeBrowserFixture ? 'qwen/qwen3.8-max,meta/muse-spark-1.2-contributor' : '',
    PI_COMMAND_CODE_BROWSER_ALLOWED_CWD_ROOTS: commandCodeBrowserFixture ? join(input.validationDir, 'workspace') : '',
    PI_COMMAND_CODE_BROWSER_AUTH_FILE: commandCodeBrowserFixture ? join(input.validationDir, 'command-code-browser-auth.json') : '',
    PI_COMMAND_CODE_BROWSER_RUNTIME_ROOTS: commandCodeBrowserFixture
      ? [join(input.validationDir, 'command-code-fixture-bin'), '/usr/bin', '/usr/lib', '/usr/lib64'].join(',')
      : '',
    COMMAND_CODE_EXECUTABLE_PATH: commandCodeFixture
      ? join(input.validationDir, 'command-code-fixture-bin', 'cmd')
      : '/root/.npm-global/bin/cmd',
    COMMAND_CODE_EXPECTED_VERSION: '1.19.0',
    COMMAND_CODE_STATE_DIR: join(input.validationDir, 'command-code'),
    COMMAND_CODE_NATIVE_HOME_DIR: join(input.validationDir, 'command-code-native-home'),
    COMMAND_CODE_ALLOWED_CWD_ROOTS: input.validationDir,
    SESSION_REGISTRY_PATH: join(input.validationDir, 'session-registry.json'),
    SESSION_DIR: piSessionsDir,
    PI_SESSIONS_DIR: piSessionsDir,
    CLAUDE_SESSION_DIR: join(input.validationDir, 'claude-sessions'),
    CLAUDE_CONFIG_DIR: join(input.validationDir, 'claude-config'),
    CLAUDE_CHANNEL_ENABLED: 'false',
    CLAUDE_CHANNEL_PLUGIN_DIR: join(input.validationDir, 'claude-channel-plugin'),
    CLAUDE_PROFILES_PATH: join(input.validationDir, 'claude-profiles.json'),
    ANTIGRAVITY_SESSION_DIR: join(input.validationDir, 'antigravity-sessions'),
    // agy stores conversation DBs in the user's global ~/.gemini directory and
    // exposes no supported data-dir override. Disable it in disposable mode so
    // validation can never create or resume a production conversation.
    ANTIGRAVITY_ENABLED: 'false',
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
