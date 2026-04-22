import { describe, it, expect, beforeEach } from 'vitest';
import {
  useTransferStore,
  type TransferSourceMeta,
  type TransferTargetMeta,
} from '../../../src/store/transferStore';

const sampleSource: TransferSourceMeta = {
  sessionId: 'src-1',
  displayName: 'My Session',
  sdkType: 'pi',
  cwd: '/home/user/project',
};

const sampleTarget: TransferTargetMeta = {
  sessionId: 'tgt-1',
  displayName: 'Target Session',
  sdkType: 'claude',
  cwd: '/home/user/other',
};

describe('transferStore', () => {
  beforeEach(() => {
    useTransferStore.getState().reset();
  });

  it('has correct initial state defaults', () => {
    const s = useTransferStore.getState();
    expect(s.isDragging).toBe(false);
    expect(s.source).toBeNull();
    expect(s.hoverTargetId).toBeNull();
    expect(s.status).toBe('idle');
    expect(s.targetMode).toBe('existing');
    expect(s.existingTarget).toBeNull();
    expect(s.newTargetRuntime).toBe('pi');
    expect(s.newTargetCwd).toBe('/root');
    expect(s.scope).toBe('visible_recent');
    expect(s.error).toBeNull();
    expect(s.createdSessionId).toBeNull();
  });

  it('startDrag sets source and isDragging', () => {
    useTransferStore.getState().startDrag(sampleSource);
    const s = useTransferStore.getState();
    expect(s.isDragging).toBe(true);
    expect(s.source).toEqual(sampleSource);
    expect(s.hoverTargetId).toBeNull();
    expect(s.error).toBeNull();
    expect(s.createdSessionId).toBeNull();
  });

  it('endDrag resets when idle', () => {
    const { startDrag } = useTransferStore.getState();
    startDrag(sampleSource);
    useTransferStore.getState().endDrag();
    const s = useTransferStore.getState();
    expect(s.isDragging).toBe(false);
    expect(s.source).toBeNull();
    expect(s.status).toBe('idle');
  });

  it('endDrag preserves state when confirming', () => {
    useTransferStore.getState().startDrag(sampleSource);
    useTransferStore.getState().openConfirmExisting(sampleSource, sampleTarget);
    useTransferStore.getState().endDrag();
    const s = useTransferStore.getState();
    expect(s.status).toBe('confirming');
    expect(s.source).toEqual(sampleSource);
    expect(s.existingTarget).toEqual(sampleTarget);
    expect(s.isDragging).toBe(false);
    expect(s.hoverTargetId).toBeNull();
  });

  it('endDrag preserves state when submitting', () => {
    useTransferStore.getState().startDrag(sampleSource);
    useTransferStore.getState().openConfirmExisting(sampleSource, sampleTarget);
    useTransferStore.getState().setSubmitting();
    useTransferStore.getState().endDrag();
    const s = useTransferStore.getState();
    expect(s.status).toBe('submitting');
    expect(s.source).toEqual(sampleSource);
    expect(s.isDragging).toBe(false);
  });

  it('setHoverTarget updates target', () => {
    useTransferStore.getState().setHoverTarget('session-abc');
    expect(useTransferStore.getState().hoverTargetId).toBe('session-abc');
    useTransferStore.getState().setHoverTarget(null);
    expect(useTransferStore.getState().hoverTargetId).toBeNull();
  });

  it('openConfirmExisting sets all fields correctly', () => {
    useTransferStore.getState().openConfirmExisting(sampleSource, sampleTarget);
    const s = useTransferStore.getState();
    expect(s.isDragging).toBe(false);
    expect(s.hoverTargetId).toBeNull();
    expect(s.status).toBe('confirming');
    expect(s.targetMode).toBe('existing');
    expect(s.source).toEqual(sampleSource);
    expect(s.existingTarget).toEqual(sampleTarget);
    expect(s.scope).toBe('visible_recent');
    expect(s.error).toBeNull();
    expect(s.createdSessionId).toBeNull();
  });

  it('openConfirmNew sets all fields correctly with source cwd as default', () => {
    useTransferStore.getState().openConfirmNew(sampleSource);
    const s = useTransferStore.getState();
    expect(s.isDragging).toBe(false);
    expect(s.hoverTargetId).toBeNull();
    expect(s.status).toBe('confirming');
    expect(s.targetMode).toBe('new');
    expect(s.source).toEqual(sampleSource);
    expect(s.existingTarget).toBeNull();
    expect(s.newTargetRuntime).toBe('pi');
    expect(s.newTargetCwd).toBe('/home/user/project');
    expect(s.scope).toBe('visible_recent');
    expect(s.error).toBeNull();
    expect(s.createdSessionId).toBeNull();
  });

  it('openConfirmNew falls back to /root when source has no cwd', () => {
    const noCwdSource: TransferSourceMeta = {
      sessionId: 'src-x',
      displayName: 'No Cwd',
      sdkType: 'opencode',
      cwd: '',
    };
    useTransferStore.getState().openConfirmNew(noCwdSource);
    expect(useTransferStore.getState().newTargetCwd).toBe('/root');
  });

  it('cancel resets everything', () => {
    useTransferStore.getState().startDrag(sampleSource);
    useTransferStore.getState().openConfirmExisting(sampleSource, sampleTarget);
    useTransferStore.getState().setScope('visible_full');
    useTransferStore.getState().cancel();
    const s = useTransferStore.getState();
    expect(s.isDragging).toBe(false);
    expect(s.source).toBeNull();
    expect(s.status).toBe('idle');
    expect(s.existingTarget).toBeNull();
    expect(s.scope).toBe('visible_recent');
  });

  it('setScope changes scope', () => {
    useTransferStore.getState().setScope('visible_full');
    expect(useTransferStore.getState().scope).toBe('visible_full');
    useTransferStore.getState().setScope('visible_recent');
    expect(useTransferStore.getState().scope).toBe('visible_recent');
  });

  it('setNewTargetRuntime changes runtime', () => {
    useTransferStore.getState().setNewTargetRuntime('claude');
    expect(useTransferStore.getState().newTargetRuntime).toBe('claude');
    useTransferStore.getState().setNewTargetRuntime('opencode');
    expect(useTransferStore.getState().newTargetRuntime).toBe('opencode');
  });

  it('setNewTargetCwd changes cwd', () => {
    useTransferStore.getState().setNewTargetCwd('/tmp/workspace');
    expect(useTransferStore.getState().newTargetCwd).toBe('/tmp/workspace');
  });

  it('setSubmitting clears error and sets status', () => {
    useTransferStore.getState().startDrag(sampleSource);
    useTransferStore.getState().openConfirmExisting(sampleSource, sampleTarget);
    useTransferStore.getState().setSubmitting();
    const s = useTransferStore.getState();
    expect(s.status).toBe('submitting');
    expect(s.error).toBeNull();
  });

  it('setSucceeded records target session', () => {
    useTransferStore.getState().setSucceeded('new-session-42');
    const s = useTransferStore.getState();
    expect(s.status).toBe('succeeded');
    expect(s.createdSessionId).toBe('new-session-42');
    expect(s.error).toBeNull();
  });

  it('setFailed records error', () => {
    useTransferStore.getState().setFailed('TIMEOUT', 'Transfer timed out');
    const s = useTransferStore.getState();
    expect(s.status).toBe('failed');
    expect(s.error).toEqual({ code: 'TIMEOUT', message: 'Transfer timed out' });
  });

  it('full workflow: drag → drop on existing → confirm → submit → succeed', () => {
    const store = useTransferStore;

    store.getState().startDrag(sampleSource);
    expect(store.getState().isDragging).toBe(true);
    expect(store.getState().source).toEqual(sampleSource);

    store.getState().setHoverTarget('tgt-1');
    expect(store.getState().hoverTargetId).toBe('tgt-1');

    store.getState().openConfirmExisting(sampleSource, sampleTarget);
    expect(store.getState().status).toBe('confirming');
    expect(store.getState().targetMode).toBe('existing');
    expect(store.getState().existingTarget).toEqual(sampleTarget);
    expect(store.getState().isDragging).toBe(false);

    store.getState().setScope('visible_full');
    expect(store.getState().scope).toBe('visible_full');

    store.getState().setSubmitting();
    expect(store.getState().status).toBe('submitting');

    store.getState().setSucceeded('created-123');
    expect(store.getState().status).toBe('succeeded');
    expect(store.getState().createdSessionId).toBe('created-123');

    store.getState().reset();
    expect(store.getState().status).toBe('idle');
    expect(store.getState().source).toBeNull();
    expect(store.getState().createdSessionId).toBeNull();
  });

  it('full workflow: drag → drop on new → confirm → submit → fail → retry', () => {
    const store = useTransferStore;

    store.getState().startDrag(sampleSource);
    expect(store.getState().isDragging).toBe(true);

    store.getState().openConfirmNew(sampleSource);
    expect(store.getState().status).toBe('confirming');
    expect(store.getState().targetMode).toBe('new');
    expect(store.getState().newTargetCwd).toBe('/home/user/project');

    store.getState().setNewTargetRuntime('claude');
    expect(store.getState().newTargetRuntime).toBe('claude');

    store.getState().setNewTargetCwd('/custom/path');
    expect(store.getState().newTargetCwd).toBe('/custom/path');

    store.getState().setSubmitting();
    expect(store.getState().status).toBe('submitting');

    store.getState().setFailed('SESSION_NOT_FOUND', 'Target session missing');
    expect(store.getState().status).toBe('failed');
    expect(store.getState().error).toEqual({
      code: 'SESSION_NOT_FOUND',
      message: 'Target session missing',
    });

    store.getState().setSubmitting();
    expect(store.getState().status).toBe('submitting');
    expect(store.getState().error).toBeNull();

    store.getState().setSucceeded('retry-ok-456');
    expect(store.getState().status).toBe('succeeded');
    expect(store.getState().createdSessionId).toBe('retry-ok-456');
  });

  it('startDrag clears previous error state', () => {
    useTransferStore.getState().setFailed('ERR', 'Something broke');
    expect(useTransferStore.getState().error).toEqual({ code: 'ERR', message: 'Something broke' });

    useTransferStore.getState().startDrag(sampleSource);
    expect(useTransferStore.getState().error).toBeNull();
    expect(useTransferStore.getState().createdSessionId).toBeNull();
    expect(useTransferStore.getState().isDragging).toBe(true);
    expect(useTransferStore.getState().source).toEqual(sampleSource);
  });
});
