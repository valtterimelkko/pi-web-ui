import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ToastContainer } from '../../../src/components/common/Toast';
import { useUIStore } from '../../../src/store/uiStore';

describe('ToastContainer', () => {
  beforeEach(() => {
    useUIStore.setState({ toasts: [] } as Partial<ReturnType<typeof useUIStore.getState>>);
  });

  it('preserves the line breaks an extension sent', () => {
    useUIStore.getState().addToast({ type: 'info', message: '🎯 Goal Report\nStatus: Idle\nAgent runs: 2' });
    render(<ToastContainer />);

    const body = screen.getByTestId('toast-message');
    expect(body.className).toContain('whitespace-pre-wrap');
    expect(body.textContent).toContain('Status: Idle');
  });

  it('auto-dismisses a short notification', () => {
    vi.useFakeTimers();
    try {
      useUIStore.getState().addToast({ type: 'info', message: 'Saved' });
      render(<ToastContainer />);
      expect(screen.getByTestId('toast-info')).toBeTruthy();

      act(() => { vi.advanceTimersByTime(6000); });
      expect(screen.queryByTestId('toast-info')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a long notification time to be read, then clears itself', () => {
    vi.useFakeTimers();
    try {
      useUIStore.getState().addToast({ type: 'info', message: 'line one\nline two', sticky: true });
      render(<ToastContainer />);

      // Long past the 5s default — still readable.
      act(() => { vi.advanceTimersByTime(15_000); });
      expect(screen.getByTestId('toast-info')).toBeTruthy();

      // But it must not camp on the composer forever (it lives on in the tray).
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(screen.queryByTestId('toast-info')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('can be dismissed by hand', () => {
    useUIStore.getState().addToast({ type: 'info', message: 'line one\nline two', sticky: true });
    render(<ToastContainer />);

    fireEvent.click(screen.getByTestId('toast-dismiss'));
    expect(screen.queryByTestId('toast-info')).toBeNull();
  });

  it('caps how tall a single toast can get', () => {
    useUIStore.getState().addToast({
      type: 'info',
      message: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'),
      sticky: true,
    });
    render(<ToastContainer />);

    const body = screen.getByTestId('toast-message');
    expect(body.className).toMatch(/max-h-/);
    expect(body.className).toContain('overflow-y-auto');
  });

  it('gives simultaneous toasts distinct keys', () => {
    const { addToast } = useUIStore.getState();
    addToast({ type: 'info', message: 'first' });
    addToast({ type: 'info', message: 'second' });

    const ids = useUIStore.getState().toasts.map((toast) => toast.id);
    expect(new Set(ids).size).toBe(2);
  });
});
