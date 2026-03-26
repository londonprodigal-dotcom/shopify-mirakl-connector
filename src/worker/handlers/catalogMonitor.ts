import { loadConfig } from '../../config';
import { MiraklClient } from '../../miraklClient';
import { query } from '../../db/pool';
import { logger } from '../../logger';

/**
 * CM11-based catalog monitor.
 * Polls Mirakl for product acceptance status (LIVE / NOT_LIVE) and logs results.
 * Fires alerts when rejection counts change significantly.
 */
export async function handleCatalogMonitor(_payload: Record<string, unknown>): Promise<void> {
  const config = loadConfig();
  const mirakl = new MiraklClient(config);

  // Get last check time for delta export
  const lastCheck = await query<{ value: unknown }>(
    `SELECT value FROM sync_state WHERE key = 'last_catalog_monitor'`
  );
  const lastValue = lastCheck.rows[0]?.value as { at?: string; live?: number } | null;
  const updatedSince = lastValue?.at ?? undefined;
  const previousLive = lastValue?.live ?? 0;

  logger.info('[catalog_monitor] Checking product statuses via CM11', { updatedSince });

  const result = await mirakl.fetchProductStatuses(updatedSince);

  logger.info('[catalog_monitor] Product status summary', {
    live: result.live,
    notLive: result.notLive,
    previousLive,
    delta: result.live - previousLive,
  });

  // Log top rejection reasons
  const topErrors = Object.entries(result.errors)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (topErrors.length > 0) {
    logger.info('[catalog_monitor] Top rejection reasons:');
    for (const [msg, count] of topErrors) {
      logger.info(`  [${count}x] ${msg}`);
    }
  }

  // Save state
  await query(
    `INSERT INTO sync_state (key, value) VALUES ('last_catalog_monitor', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify({
      at: new Date().toISOString(),
      live: result.live,
      notLive: result.notLive,
      topErrors: topErrors.slice(0, 5).map(([msg, count]) => ({ msg, count })),
    })]
  );

  // Alert if live count dropped (products were de-listed)
  if (previousLive > 0 && result.live < previousLive - 10) {
    await query(
      `INSERT INTO alerts (severity, category, message, metadata) VALUES ('critical', 'catalog_monitor', $1, $2)`,
      [
        `Product live count dropped from ${previousLive} to ${result.live} (-${previousLive - result.live})`,
        JSON.stringify({ live: result.live, notLive: result.notLive, previousLive }),
      ]
    );
  }

  // Alert if new products went live (positive signal)
  if (result.live > previousLive + 50) {
    logger.info(`[catalog_monitor] ${result.live - previousLive} new products went LIVE`);
  }
}
