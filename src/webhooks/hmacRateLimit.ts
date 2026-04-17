import { logger } from '../logger';

/**
 * Rate-limited HMAC mismatch logger.
 * Logs the first occurrence, then suppresses for 60s per webhook type,
 * reporting a count of suppressed mismatches when the window expires.
 */
const state = new Map<string, { count: number; lastLogged: number }>();

const WINDOW_MS = 60_000;

export function logHmacMismatch(webhookType: string): void {
  const now = Date.now();
  const entry = state.get(webhookType);

  if (!entry || now - entry.lastLogged >= WINDOW_MS) {
    // Log this occurrence (include suppressed count from previous window if any)
    const suppressed = entry?.count ?? 0;
    const suffix = suppressed > 0 ? ` (${suppressed} suppressed in last 60s)` : '';
    logger.warn(`Shopify ${webhookType} webhook HMAC mismatch${suffix}`);
    state.set(webhookType, { count: 0, lastLogged: now });
  } else {
    // Suppress — just increment counter
    entry.count++;
  }
}
