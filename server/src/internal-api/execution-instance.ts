import type { RegistryEntry } from '../session-registry.js';

/**
 * Resolve the configured runtime instance that handled a session.
 *
 * This deliberately remains a small projection rather than an
 * ExecutionBinding schema. Claude profiles are the only configurable
 * non-default instances today; the other runtime families each have one
 * local instance.
 */
export function resolveExecutionInstanceId(
  entry: Pick<RegistryEntry, 'sdkType' | 'claudeProfileId'>,
): string {
  switch (entry.sdkType) {
    case 'claude':
      return entry.claudeProfileId ?? 'claude-default';
    case 'opencode':
      return 'opencode-default';
    case 'antigravity':
      return 'antigravity-default';
    case 'pi':
    default:
      return 'pi-local-default';
  }
}
