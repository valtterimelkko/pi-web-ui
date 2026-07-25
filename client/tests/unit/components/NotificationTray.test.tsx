import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NotificationBell, NotificationTray } from '../../../src/components/common/NotificationTray';
import { useUIStore } from '../../../src/store/uiStore';

function log(message: string, sessionId: string | null = 'session-1') {
  useUIStore.getState().logNotification({ type: 'info', message, sessionId });
}

describe('notification tray', () => {
  beforeEach(() => {
    useUIStore.setState({
      notificationLog: [],
      notificationTrayOpen: false,
    } as Partial<ReturnType<typeof useUIStore.getState>>);
  });

  it('hides the bell until something has been notified', () => {
    const { container } = render(<NotificationBell />);
    expect(container.firstChild).toBeNull();
  });

  it('marks unread notifications and clears the badge when opened', () => {
    log('🎯 Goal achieved in 2 agent runs');
    render(<NotificationBell />);

    expect(screen.getByTestId('notification-unread-badge').textContent).toBe('1');

    fireEvent.click(screen.getByTestId('notification-bell'));
    expect(useUIStore.getState().notificationTrayOpen).toBe(true);
    expect(screen.queryByTestId('notification-unread-badge')).toBeNull();
  });

  it('lists notifications newest first with their formatting intact', () => {
    log('older');
    log('🎯 Goal Report\nStatus: Idle\nAgent runs: 2');
    useUIStore.getState().openNotificationTray();

    render(<NotificationTray />);

    const entries = screen.getAllByTestId('notification-entry');
    expect(entries).toHaveLength(2);
    expect(entries[0].textContent).toContain('Goal Report');
    expect(entries[0].textContent).toContain('Agent runs: 2');
    expect(entries[0].querySelector('[data-testid="notification-message"]')!.className)
      .toContain('whitespace-pre-wrap');
    expect(entries[1].textContent).toContain('older');
  });

  it('closes and clears from the tray', () => {
    log('one');
    useUIStore.getState().openNotificationTray();
    render(<NotificationTray />);

    fireEvent.click(screen.getByTestId('notification-clear'));
    expect(useUIStore.getState().notificationLog).toEqual([]);

    fireEvent.click(screen.getByTestId('notification-close'));
    expect(useUIStore.getState().notificationTrayOpen).toBe(false);
  });

  it('renders nothing while closed', () => {
    log('one');
    const { container } = render(<NotificationTray />);
    expect(container.firstChild).toBeNull();
  });
});
