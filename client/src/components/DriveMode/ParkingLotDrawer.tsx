import type { VoiceParkedItem } from '@pi-web-ui/shared';
import { ArrowUpRight, Inbox, RefreshCw } from 'lucide-react';

/**
 * ParkingLotDrawer — the four-object model's parking lot (§16.2).
 *
 * Things flagged while the worker was busy, held as the operator's own words
 * and shown as a full ordered snapshot (oldest first) so a reconnect needs no
 * delta bookkeeping. Each row has exactly ONE promotion action: promoting is
 * per instruction and creates a proposal that still needs its own confirmation,
 * so there is no "send all" control, by design (N3). The component never sends
 * anything itself — `onPromote(itemId)` names one item and the surface builds
 * the typed `parking_promote` frame.
 */

export interface ParkingLotDrawerProps {
  items: VoiceParkedItem[];
  /** Promote exactly this item. */
  onPromote: (itemId: string) => void;
  /** Ask the server to re-send the snapshot. */
  onRequestList?: () => void;
  /** The item currently being promoted (disables its own button only). */
  busyItemId?: string | null;
  open?: boolean;
  onToggle?: (open: boolean) => void;
}

export function ParkingLotDrawer({
  items,
  onPromote,
  onRequestList,
  busyItemId = null,
  open = true,
  onToggle,
}: ParkingLotDrawerProps) {
  if (!open) {
    return (
      <button
        type="button"
        data-testid="parking-lot-open"
        className="inline-flex items-center gap-1.5 rounded-lg border border-outline-default dark:border-outline-default-dark px-3 py-1.5 text-xs"
        onClick={() => onToggle?.(true)}
      >
        <Inbox size={13} aria-hidden />
        Parked items ({items.length})
      </button>
    );
  }

  return (
    <section
      className="w-full max-w-md rounded-2xl border border-outline-default dark:border-outline-default-dark bg-surface dark:bg-surface-dark px-4 py-3"
      aria-label="Parking lot"
      data-testid="parking-lot"
      data-item-count={String(items.length)}
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-content-primary dark:text-content-primary-dark">
          Parked — raise later
        </h3>
        <div className="flex items-center gap-1">
          {onRequestList && (
            <button
              type="button"
              data-testid="parking-lot-refresh"
              title="Read the parking lot back"
              className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10"
              onClick={onRequestList}
            >
              <RefreshCw size={13} aria-hidden />
            </button>
          )}
          {onToggle && (
            <button
              type="button"
              data-testid="parking-lot-close"
              className="text-[11px] text-content-muted dark:text-content-muted-dark"
              onClick={() => onToggle(false)}
            >
              hide
            </button>
          )}
        </div>
      </header>

      {items.length === 0 ? (
        <p className="mt-2 text-xs text-content-muted dark:text-content-muted-dark" data-testid="parking-lot-empty">
          Nothing parked. Say “remember to ask about…” while the worker is busy.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5" data-testid="parking-lot-items">
          {items.map((item) => (
            <li
              key={item.itemId}
              className="flex items-start justify-between gap-2 rounded-lg border border-outline-default/60 dark:border-outline-default-dark/60 px-2.5 py-1.5"
              data-testid={`parking-item-${item.itemId}`}
            >
              <span className="text-sm text-content-primary dark:text-content-primary-dark break-words">
                {item.text}
              </span>
              <button
                type="button"
                data-testid={`parking-promote-${item.itemId}`}
                disabled={busyItemId === item.itemId}
                title="Promote this one item (still needs its own confirmation)"
                className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md border border-outline-default dark:border-outline-default-dark px-2 py-0.5 text-[11px] disabled:opacity-50"
                onClick={() => onPromote(item.itemId)}
              >
                <ArrowUpRight size={12} aria-hidden />
                Promote
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-[11px] text-content-muted dark:text-content-muted-dark" data-testid="parking-lot-rule">
        One at a time — promotion still needs its own confirmation.
      </p>
    </section>
  );
}
