import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ExtensionDialog } from '../../../src/components/Extensions/ExtensionDialog';
import { useSessionStore } from '../../../src/store/sessionStore';

const CONFIRM_REQUEST = {
  id: 'req-1',
  type: 'confirm' as const,
  method: 'confirm',
  params: {
    title: 'Clear goal?',
    message: 'This will permanently stop the goal:\n"Write poem.txt"\n\n1 agent run completed.',
  },
  timeout: 30000,
  receivedAt: Date.now(),
};

describe('ExtensionDialog', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('shows the extension-provided title instead of a generic heading', () => {
    render(<ExtensionDialog request={CONFIRM_REQUEST} onResponse={vi.fn()} />);

    expect(screen.getByTestId('extension-dialog-title').textContent).toBe('Clear goal?');
  });

  it('keeps the message formatting the extension sent', () => {
    render(<ExtensionDialog request={CONFIRM_REQUEST} onResponse={vi.fn()} />);

    const message = screen.getByTestId('extension-dialog-message');
    expect(message.className).toContain('whitespace-pre-wrap');
    expect(message.textContent).toContain('1 agent run completed.');
  });

  it('counts down to the request timeout so a dialog is never silently stale', () => {
    vi.useFakeTimers();
    try {
      const receivedAt = Date.now();
      render(
        <ExtensionDialog
          request={{ ...CONFIRM_REQUEST, receivedAt, timeout: 30000 }}
          onResponse={vi.fn()}
        />,
      );

      expect(screen.getByTestId('extension-dialog-expiry').textContent).toContain('30s');
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(screen.getByTestId('extension-dialog-expiry').textContent).toContain('20s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to a neutral title when the extension sent none', () => {
    render(
      <ExtensionDialog
        request={{ ...CONFIRM_REQUEST, params: { message: 'Proceed?' } }}
        onResponse={vi.fn()}
      />,
    );
    expect(screen.getByTestId('extension-dialog-title').textContent).toBe('Extension Request');
  });
});

describe('extension_ui_cancel handling', () => {
  beforeEach(() => {
    useSessionStore.setState({
      currentSessionId: 'session-1',
      extensionUIRequest: { ...CONFIRM_REQUEST },
    } as Partial<ReturnType<typeof useSessionStore.getState>>);
  });

  it('closes the dialog outright when another device answered it', () => {
    useSessionStore.getState().handleServerMessage({
      type: 'extension_ui_cancel',
      request: { id: 'req-1', reason: 'answered' },
    });

    expect(useSessionStore.getState().extensionUIRequest).toBeNull();
  });

  it('still marks timeouts as expired so the draft survives', () => {
    useSessionStore.getState().handleServerMessage({
      type: 'extension_ui_cancel',
      request: { id: 'req-1', reason: 'timeout' },
    });

    const request = useSessionStore.getState().extensionUIRequest;
    expect(request?.expired).toBe(true);
    expect(request?.expiredReason).toBe('timeout');
  });

  it('ignores a cancel for a different request', () => {
    useSessionStore.getState().handleServerMessage({
      type: 'extension_ui_cancel',
      request: { id: 'other', reason: 'answered' },
    });

    expect(useSessionStore.getState().extensionUIRequest?.id).toBe('req-1');
  });
});
