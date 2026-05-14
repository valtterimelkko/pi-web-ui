export type RuntimeSdkType = 'pi' | 'claude' | 'opencode' | null | undefined;

export function isPiSlashCommandAllowedWhileStreaming(
  draft: string,
  isStreaming: boolean,
  sdkType: RuntimeSdkType,
): boolean {
  return isStreaming && sdkType === 'pi' && draft.trimStart().startsWith('/');
}

export function shouldPauseGoalOnStop(
  sdkType: RuntimeSdkType,
  goalStatus: string | undefined,
): boolean {
  if (!goalStatus) return false;
  const normalized = goalStatus.trim().toLowerCase();
  const isActive = normalized === 'wrapping-up' || normalized.startsWith('running');
  if (!isActive) return false;
  // Pi: user triggers /goal pause-now slash command before abort.
  // OpenCode: server pauses goal state automatically on abort (no extra client action needed).
  return sdkType === 'pi' || sdkType === 'opencode';
}
