import { describe, it, expect, beforeEach } from 'vitest';
import { useDriveModeStore, DRIVE_MODE_MODELS } from '../../../src/store/driveModeStore';

describe('driveModeStore', () => {
  beforeEach(() => {
    useDriveModeStore.setState({
      isOpen: false,
      phase: 'entry',
      selectedModelId: null,
      activeSessionId: null,
      lastAssistantText: null,
    });
  });

  it('has correct initial state', () => {
    const state = useDriveModeStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.phase).toBe('entry');
    expect(state.selectedModelId).toBeNull();
    expect(state.activeSessionId).toBeNull();
    expect(state.lastAssistantText).toBeNull();
  });

  it('open() sets isOpen and phase correctly', () => {
    useDriveModeStore.getState().open();
    const state = useDriveModeStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.phase).toBe('entry');
    expect(state.selectedModelId).toBeNull();
  });

  it('close() resets everything', () => {
    useDriveModeStore.getState().open();
    useDriveModeStore.getState().selectModel('kimi-for-coding');
    useDriveModeStore.getState().close();
    const state = useDriveModeStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.selectedModelId).toBeNull();
  });

  it('setPhase transitions correctly', () => {
    useDriveModeStore.getState().setPhase('model-pick');
    expect(useDriveModeStore.getState().phase).toBe('model-pick');
  });

  it('selectModel sets selectedModelId', () => {
    useDriveModeStore.getState().selectModel('codex/gpt-5.4');
    expect(useDriveModeStore.getState().selectedModelId).toBe('codex/gpt-5.4');
  });

  it('setActiveSession sets activeSessionId', () => {
    useDriveModeStore.getState().setActiveSession('session-123');
    expect(useDriveModeStore.getState().activeSessionId).toBe('session-123');
  });

  it('setLastAssistantText sets text', () => {
    useDriveModeStore.getState().setLastAssistantText('Hello world');
    expect(useDriveModeStore.getState().lastAssistantText).toBe('Hello world');
  });

  it('reset keeps isOpen true but resets phase', () => {
    useDriveModeStore.getState().open();
    useDriveModeStore.getState().setPhase('dictate');
    useDriveModeStore.getState().selectModel('some-model');
    useDriveModeStore.getState().reset();
    const state = useDriveModeStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.phase).toBe('entry');
    expect(state.selectedModelId).toBeNull();
  });

  it('includes the three GPT-5.6 Codex models through the Pi runtime', () => {
    expect(DRIVE_MODE_MODELS).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'openai-codex/gpt-5.6-terra',
        displayName: 'Codex / GPT-5.6 Terra',
        sdkType: 'pi',
      }),
      expect.objectContaining({
        id: 'openai-codex/gpt-5.6-luna',
        displayName: 'Codex / GPT-5.6 Luna',
        sdkType: 'pi',
      }),
      expect.objectContaining({
        id: 'openai-codex/gpt-5.6-sol',
        displayName: 'Codex / GPT-5.6 Sol',
        sdkType: 'pi',
      }),
    ]));
  });

  it('DRIVE_MODE_MODELS have required fields', () => {
    DRIVE_MODE_MODELS.forEach((model) => {
      expect(model.id).toBeTruthy();
      expect(model.displayName).toBeTruthy();
      expect(['pi', 'claude', 'opencode']).toContain(model.sdkType);
    });
  });

  it('includes GLM-5.2 as the OpenCode Drive Mode option', () => {
    expect(DRIVE_MODE_MODELS).toContainEqual(
      expect.objectContaining({
        id: 'zai-coding-plan/glm-5.2',
        displayName: 'GLM-5.2',
        sdkType: 'opencode',
      })
    );
  });

  it('DRIVE_MODE_MODELS have no duplicate IDs', () => {
    const ids = DRIVE_MODE_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
