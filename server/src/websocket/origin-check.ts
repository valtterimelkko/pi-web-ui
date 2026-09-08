/**
 * WebSocket origin check. Production keeps the exact configured allowlist.
 * Non-production (dev/test) additionally accepts any `http://localhost:<port>`
 * origin so disposable validation servers on random ports work without
 * pre-knowing the port; nothing else is relaxed.
 */
export function isWebSocketOriginAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[],
  nodeEnv: string,
): boolean {
  if (!origin) return false;
  if (allowedOrigins.includes(origin)) return true;
  return nodeEnv !== 'production' && /^http:\/\/localhost:\d+$/.test(origin);
}
