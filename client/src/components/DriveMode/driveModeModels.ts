import type { DriveModeModel } from '../../store/driveModeStore';

export const DRIVE_MODE_MODELS: DriveModeModel[] = [
  { id: 'kimi-coding/kimi-for-coding', displayName: 'Kimi for Coding', sdkType: 'pi' },
  { id: 'zai-coding-plan/glm-5.1', displayName: 'GLM-5.1', sdkType: 'opencode' },
  { id: 'openai-codex/gpt-5.4', displayName: 'Codex / GPT-5.4', sdkType: 'pi' },
  { id: 'openai-codex/gpt-5.5', displayName: 'Codex / GPT-5.5', sdkType: 'pi' },
];
