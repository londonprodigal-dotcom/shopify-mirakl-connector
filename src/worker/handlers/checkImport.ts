import { loadConfig } from '../../config';
import { MiraklClient } from '../../miraklClient';
import { query } from '../../db/pool';
import { logger } from '../../logger';

/**
 * Pending import state stored in Postgres sync_state table (accessible from Railway worker).
 */
interface PendingImport {
  importId: number | string;
  offersCsvPath: string;
  uploadedAt: string;
}

async function getPendingImport(): Promise<PendingImport | null> {
  const result = await query<{ value: unknown }>(
    `SELECT value FROM sync_state WHERE key = 'pending_product_import'`
  );
  if (!result.rows[0]?.value) return null;
  const val = typeof result.rows[0].value === 'string'
    ? JSON.parse(result.rows[0].value)
    : result.rows[0].value;
  if (!val || !val.importId) return null;
  return val as PendingImport;
}

async function clearPendingImport(): Promise<void> {
  await query(`DELETE FROM sync_state WHERE key = 'pending_product_import'`);
}

/**
 * Worker handler for check_import jobs.
 * Polls PA01 import status — if still processing, returns (will be re-run by scheduler).
 * Once PA01 completes, uploads OF01 offers automatically.
 */
export async function handleCheckImport(_payload: Record<string, unknown>): Promise<void> {
  const pending = await getPendingImport();

  if (!pending) {
    // No pending import — nothing to do (normal state most of the time)
    return;
  }

  const config = loadConfig();
  const { importId, offersCsvPath, uploadedAt } = pending;
  const elapsed = Math.round((Date.now() - new Date(uploadedAt).getTime()) / 60000);
  logger.info('[check_import] Checking PA01 product import', { importId, elapsed: `${elapsed}min` });

  const mirakl = new MiraklClient(config);
  const status = await mirakl.getProductImportStatus(importId);

  logger.info('[check_import] PA01 import status', {
    importId,
    status: status.importStatus,
    linesRead: status.linesRead,
    linesOk: status.linesOk,
    linesError: status.linesError,
  });

  // ─── Still processing — scheduler will re-run in 5 min ─────────────────
  // Known Mirakl bug: status API can stay at SENT even after Mirakl emails completion.
  // If stuck at SENT for >30 min AND linesRead > 0, treat as complete and proceed.
  const stuckAtSent = status.importStatus === 'SENT' && elapsed > 30 && status.linesRead > 0;
  if (stuckAtSent) {
    logger.warn(`[check_import] PA01 stuck at SENT for ${elapsed}min with ${status.linesRead} lines read — treating as complete (known Mirakl API bug)`);
  } else if (status.importStatus === 'WAITING' || status.importStatus === 'RUNNING' || status.importStatus === 'SENT') {
    logger.info(`[check_import] Still ${status.importStatus} (${elapsed}min). Will check again next cycle.`);
    return;
  }

  // ─── Complete — log errors if any ──────────────────────────────────────────
  if (status.linesError > 0 && status.hasTransformationErrorReport) {
    logger.warn(`[check_import] PA01 completed with ${status.linesError} transformation errors`);
    try {
      const errData = await mirakl.getTransformationErrorReport(importId);
      const lines = errData.split('\n');
      const headers = lines[0].split(';').map((h: string) => h.replace(/"/g, ''));
      const errColIdx = headers.findIndex((h: string) => h.toLowerCase() === 'errors');

      if (errColIdx >= 0) {
        const errCounts: Record<string, number> = {};
        for (let i = 1; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          const cols = lines[i].split(';').map((c: string) => c.replace(/^"|"$/g, ''));
          const msg = cols[errColIdx] || '(empty)';
          errCounts[msg] = (errCounts[msg] ?? 0) + 1;
        }
        logger.warn('[check_import] Error summary:');
        for (const [msg, count] of Object.entries(errCounts).sort((a, b) => b[1] - a[1])) {
          logger.warn(`  [${count}x] ${msg.substring(0, 200)}`);
        }
      }
    } catch (err) {
      logger.error('[check_import] Could not fetch transformation error report', { error: String(err) });
    }
  }

  if (status.linesOk === 0) {
    logger.error('[check_import] PA01 import produced zero successful lines. Fix errors and re-sync.');
    await clearPendingImport();
    return;
  }

  logger.info(`[check_import] PA01 complete: ${status.linesOk}/${status.linesRead} lines succeeded`);

  // ─── Upload OF01 (offers) ────────────────────────────────────────────────
  if (offersCsvPath) {
    logger.info('[check_import] Uploading offers to Mirakl OF01...', { path: offersCsvPath });
    const offerImportId = await mirakl.uploadOffersFile(offersCsvPath);
    logger.info('[check_import] OF01 upload accepted', { importId: offerImportId });

    const offerResult = await mirakl.pollUntilDone(offerImportId, 'offers');
    logger.info('[check_import] OF01 import result', {
      status: offerResult.status,
      linesOk: offerResult.lines_in_success,
      linesError: offerResult.lines_in_error,
    });

    if (offerResult.lines_in_error > 0) {
      try {
        await mirakl.downloadErrorReport(offerImportId, 'offers');
      } catch { /* logged inside downloadErrorReport */ }
    }
  } else {
    logger.info('[check_import] No offers CSV to upload.');
  }

  // ─── Clear pending state ─────────────────────────────────────────────────
  await clearPendingImport();
  logger.info('[check_import] Import workflow complete.');
}
