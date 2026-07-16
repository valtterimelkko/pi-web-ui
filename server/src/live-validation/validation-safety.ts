import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const PRODUCTION_VALIDATION_ERROR =
  'Refusing to run live validation against the default production Pi Web UI Internal API. ' +
  'Start a disposable validation server with `npm run validate:server` and pass both ' +
  '`--socket <path>` and `--token-path <path>`, or pass `--allow-production` only when the user explicitly asked to validate against the running production Web UI.';

export interface ValidationTargetInput {
  socketPath?: string;
  tokenPath?: string;
  allowProduction?: boolean;
  /** Configured production paths; defaults to env/default locations. */
  productionSocketPath?: string;
  productionTokenPath?: string;
}

export interface ValidationTarget {
  socketPath?: string;
  tokenPath?: string;
  usingProductionServer: boolean;
}

export function resolveValidationTarget(input: ValidationTargetInput): ValidationTarget {
  const hasSocket = Boolean(input.socketPath);
  const hasTokenPath = Boolean(input.tokenPath);

  if (hasSocket !== hasTokenPath) {
    throw new Error('Live validation against an isolated server requires both --socket and --token-path.');
  }

  if (hasSocket && hasTokenPath) {
    const productionSocket = canonicalPath(input.productionSocketPath
      ?? process.env.INTERNAL_API_SOCKET_PATH
      ?? resolve(homedir(), '.pi-web-ui', 'internal-api.sock'));
    const productionToken = canonicalPath(input.productionTokenPath
      ?? process.env.INTERNAL_API_TOKEN_PATH
      ?? resolve(homedir(), '.pi-web-ui', 'internal-api-token'));
    const targetsProduction = canonicalPath(input.socketPath!) === productionSocket
      || canonicalPath(input.tokenPath!) === productionToken;

    if (targetsProduction && !input.allowProduction) {
      throw new Error(PRODUCTION_VALIDATION_ERROR);
    }

    return {
      socketPath: input.socketPath,
      tokenPath: input.tokenPath,
      usingProductionServer: targetsProduction,
    };
  }

  if (input.allowProduction) {
    return {
      usingProductionServer: true,
    };
  }

  throw new Error(PRODUCTION_VALIDATION_ERROR);
}

function canonicalPath(input: string): string {
  const absolute = resolve(input);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}
