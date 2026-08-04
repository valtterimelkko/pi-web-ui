import { ErrorCode } from './error-codes.js';

export const DEFAULT_INTERNAL_API_BLOCKED_PI_PROVIDERS = ['openai', 'openrouter'] as const;

export function parseBlockedPiProviders(raw: string | undefined): string[] {
  const source = raw === undefined
    ? DEFAULT_INTERNAL_API_BLOCKED_PI_PROVIDERS.join(',')
    : raw;
  return [...new Set(source
    .split(',')
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean))];
}

export function providerFromPiModelReference(modelReference: string | undefined): string | undefined {
  if (!modelReference) return undefined;
  const separator = modelReference.indexOf('/');
  if (separator <= 0) return undefined;
  return modelReference.slice(0, separator).trim().toLowerCase() || undefined;
}

export function blockedPiProvider(
  modelReference: string | undefined,
  blockedProviders: readonly string[],
): string | undefined {
  const provider = providerFromPiModelReference(modelReference);
  if (!provider) return undefined;
  return blockedProviders.some((candidate) => candidate.toLowerCase() === provider)
    ? provider
    : undefined;
}

export class PiProviderNotAllowedError extends Error {
  readonly code = ErrorCode.PROVIDER_NOT_ALLOWED;

  constructor(readonly provider?: string) {
    super(provider
      ? `Pi provider '${provider}' is not allowed for agent execution through the Internal API`
      : 'Pi provider could not be resolved safely for agent execution through the Internal API');
    this.name = 'PiProviderNotAllowedError';
  }
}

export function assertPiModelAllowed(
  modelReference: string | undefined,
  blockedProviders: readonly string[],
): void {
  const provider = blockedPiProvider(modelReference, blockedProviders);
  if (provider) throw new PiProviderNotAllowedError(provider);
}

/** Fail closed at an execution boundary when no exact provider can be proven. */
export function assertResolvedPiModelAllowed(
  modelReference: string | undefined,
  blockedProviders: readonly string[],
): void {
  if (!providerFromPiModelReference(modelReference)) {
    throw new PiProviderNotAllowedError();
  }
  assertPiModelAllowed(modelReference, blockedProviders);
}
