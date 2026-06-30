/**
 * Notification Formatter
 *
 * Pure: turns session metadata + the agent's tail message into a Telegram-ready
 * { title, body, deepLink }. Truncation happens here (well under Telegram's
 * 4096-char limit); the channel additionally enforces a hard 4096 safety net.
 * Tail *extraction* from a transcript/screen-view is the manager's job — this
 * module only formats text it is handed.
 */

import type { NotificationKind, NotificationRuntime } from './types.js';

const FALLBACK_BODY = '_(No message body — open the session to see what it said.)_';
const TRUNCATION_MARKER = '\n…(truncated, open session)';
/** Cap on the session name in the title — a renamed name is short, but an
 *  un-renamed session's auto-name can be a full first message. */
const LABEL_MAX_CHARS = 80;

/** Trims and bounds a label for use in the title; leaves short labels intact. */
function clampLabel(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= LABEL_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, LABEL_MAX_CHARS - 1).trimEnd()}…`;
}

export function runtimeLabel(runtime?: NotificationRuntime): string {
  switch (runtime) {
    case 'pi':
      return 'Pi';
    case 'claude':
      return 'Claude';
    case 'opencode':
      return 'OpenCode';
    case 'antigravity':
      return 'Antigravity';
    default:
      return 'Session';
  }
}

export interface FormatterInput {
  sessionId?: string;
  runtime?: NotificationRuntime;
  /** Operator-friendly session name; falls back to the runtime label. */
  label?: string;
  kind: NotificationKind;
  /** The agent's last message tail (already extracted by the caller). */
  tail?: string;
}

export interface FormatterOptions {
  tailMaxChars: number;
  publicBaseUrl?: string;
}

export interface FormatterOutput {
  title: string;
  body: string;
  deepLink?: string;
}

function truncateTail(tail: string | undefined, max: number): string {
  const text = (tail ?? '').trim();
  if (!text) return FALLBACK_BODY;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}${TRUNCATION_MARKER}`;
}

function buildDeepLink(baseUrl: string, sessionId: string): string {
  return `${baseUrl}?session=${encodeURIComponent(sessionId)}`;
}

export function formatNotification(input: FormatterInput, opts: FormatterOptions): FormatterOutput {
  const name = clampLabel((input.label && input.label.trim()) || runtimeLabel(input.runtime));
  const title =
    input.kind === 'agent_end' ? `🤖 ${name} · waiting for you` : `📢 ${name}`;
  const body = truncateTail(input.tail, opts.tailMaxChars);
  const deepLink =
    input.sessionId && opts.publicBaseUrl
      ? buildDeepLink(opts.publicBaseUrl, input.sessionId)
      : undefined;
  return { title, body, deepLink };
}
