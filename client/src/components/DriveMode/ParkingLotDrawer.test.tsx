import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { VoiceParkedItem } from '@pi-web-ui/shared';
import { ParkingLotDrawer } from './ParkingLotDrawer';

const items: VoiceParkedItem[] = [
  { itemId: 'item-1', text: 'ask about the retry logic', createdAtMs: 1 },
  { itemId: 'item-2', text: 'mention the flaky test', createdAtMs: 2 },
  { itemId: 'item-3', text: 'check the timeout constant', createdAtMs: 3 },
];

const noop = () => undefined;

describe('ParkingLotDrawer', () => {
  it('renders the snapshot oldest-first with one action per item', () => {
    render(<ParkingLotDrawer items={items} onPromote={noop} />);
    const rows = screen.getAllByTestId(/^parking-item-/);
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'parking-item-item-1',
      'parking-item-item-2',
      'parking-item-item-3',
    ]);
    for (const item of items) {
      expect(screen.getByTestId(`parking-promote-${item.itemId}`)).toBeTruthy();
    }
  });

  it('promotes exactly one item per click — never a batch', () => {
    const onPromote = vi.fn();
    render(<ParkingLotDrawer items={items} onPromote={onPromote} />);
    fireEvent.click(screen.getByTestId('parking-promote-item-2'));
    expect(onPromote).toHaveBeenCalledTimes(1);
    expect(onPromote).toHaveBeenCalledWith('item-2');
    // Nothing else was promoted by that click.
    expect(onPromote).not.toHaveBeenCalledWith('item-1');
    expect(onPromote).not.toHaveBeenCalledWith('item-3');
  });

  it('has no batch send / promote-all control at all (N3 is per instruction)', () => {
    render(<ParkingLotDrawer items={items} onPromote={noop} onRequestList={noop} />);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/promote all|send all|release all|batch/i);
    // Exactly one actionable promote button per item, and nothing else that promotes.
    const promoteButtons = screen.getAllByRole('button').filter((button) =>
      (button.getAttribute('data-testid') ?? '').startsWith('parking-promote-'),
    );
    expect(promoteButtons).toHaveLength(items.length);
    expect(screen.getByTestId('parking-lot-rule').textContent).toContain('One at a time');
  });

  it('says the rule out loud so promotion is never read as release', () => {
    render(<ParkingLotDrawer items={items} onPromote={noop} />);
    expect(screen.getByTestId('parking-lot-rule').textContent).toContain(
      'still needs its own confirmation',
    );
  });

  it('shows an empty state that teaches how to park something', () => {
    render(<ParkingLotDrawer items={[]} onPromote={noop} />);
    expect(screen.getByTestId('parking-lot-empty')).toBeTruthy();
    expect(screen.getByTestId('parking-lot').getAttribute('data-item-count')).toBe('0');
  });

  it('answers the read-back control with the typed parking_list request', () => {
    const onRequestList = vi.fn();
    render(<ParkingLotDrawer items={items} onPromote={noop} onRequestList={onRequestList} />);
    fireEvent.click(screen.getByTestId('parking-lot-refresh'));
    expect(onRequestList).toHaveBeenCalledTimes(1);
  });

  it('disables only the item currently being promoted', () => {
    render(<ParkingLotDrawer items={items} onPromote={noop} busyItemId="item-2" />);
    expect((screen.getByTestId('parking-promote-item-2') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('parking-promote-item-1') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('parking-promote-item-3') as HTMLButtonElement).disabled).toBe(false);
  });

  it('can be collapsed to a single control', () => {
    const onToggle = vi.fn();
    render(<ParkingLotDrawer items={items} onPromote={noop} open={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('parking-lot-open'));
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});
