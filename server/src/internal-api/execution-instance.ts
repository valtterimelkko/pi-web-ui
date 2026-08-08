import type { RegistryEntry } from '../session-registry.js';
import type { SessionRuntime } from './types.js';

/**
 * Resolve the configured runtime instance that handled a session.
 *
 * This deliberately remains a small projection rather than an
 * ExecutionBinding schema. Claude profiles are the only configurable
 * non-default instances today; the other runtime families each have one
 * local instance.
 */
export function resolveExecutionInstanceId(
  entry: Pick<RegistryEntry, 'sdkType' | 'claudeProfileId'> | { sdkType: 'commandcode'; claudeProfileId?: never },
): string {
  switch (entry.sdkType as SessionRuntime) {
    case 'claude':
      return entry.claudeProfileId ?? 'claude-default';
    case 'opencode':
      return 'opencode-default';
    case 'antigravity':
      return 'antigravity-default';
    case 'commandcode':
      return 'commandcode-default';
    case 'pi':
    default:
      return 'pi-local-default';
  }
}
