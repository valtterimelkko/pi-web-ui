export const PRODUCTION_VALIDATION_ERROR =
  'Refusing to run live validation against the default production Pi Web UI Internal API. ' +
  'Start a disposable validation server with `npm run validate:server` and pass both ' +
  '`--socket <path>` and `--token-path <path>`, or pass `--allow-production` only when the user explicitly asked to validate against the running production Web UI.';

export interface ValidationTargetInput {
  socketPath?: string;
  tokenPath?: string;
  allowProduction?: boolean;
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
    return {
      socketPath: input.socketPath,
      tokenPath: input.tokenPath,
      usingProductionServer: false,
    };
  }

  if (input.allowProduction) {
    return {
      usingProductionServer: true,
    };
  }

  throw new Error(PRODUCTION_VALIDATION_ERROR);
}
