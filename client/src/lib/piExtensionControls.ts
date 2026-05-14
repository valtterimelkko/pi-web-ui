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
  if (sdkType !== 'pi' || !goalStatus) return false;
  const normalized = goalStatus.trim().toLowerCase();
  return normalized === 'wrapping-up' || normalized.startsWith('running');
}
