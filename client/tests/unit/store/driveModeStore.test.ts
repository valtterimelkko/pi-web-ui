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

  it('DRIVE_MODE_MODELS has 4 models', () => {
    expect(DRIVE_MODE_MODELS).toHaveLength(4);
  });

  it('DRIVE_MODE_MODELS have required fields', () => {
    DRIVE_MODE_MODELS.forEach((model) => {
      expect(model.id).toBeTruthy();
      expect(model.displayName).toBeTruthy();
      expect(['pi', 'claude', 'opencode']).toContain(model.sdkType);
    });
  });

  it('DRIVE_MODE_MODELS have no duplicate IDs', () => {
    const ids = DRIVE_MODE_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
