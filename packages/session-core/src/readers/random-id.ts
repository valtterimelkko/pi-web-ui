/**
 * UUID source for synthesized replay ids. Uses the Web Crypto global (present
 * in browsers and in Node 19+) instead of `node:crypto`, so the readers stay
 * importable from a browser bundle.
 */
const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;

export function randomUUID(): string {
  if (!webCrypto?.randomUUID) throw new Error('crypto.randomUUID is unavailable in this environment');
  return webCrypto.randomUUID();
}
