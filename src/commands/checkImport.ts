import { loadConfig } from '../config';
import { MiraklClient } from '../miraklClient';
import { StateManager } from '../state/stateManager';
import { logger } from '../logger';

// ─── Check pending PA01 import, upload OF01 if complete ──────────────────────

export async function runCheckImport(): Promise<void> {
  const config = loadConfig();
  const state  = new StateManager(config.paths.state);
  const current = state.read();

  if (!current.pendingProductImport) {
    logger.info('No pending product import. Nothing to do.');
    return;
  }

  const { importId, offersCsvPath, uploadedAt } = current.pendingProductImport;
  logger.info('Checking PA01 product import', { importId, uploadedAt });

  const mirakl = new MiraklClient(config);
  const status = await mirakl.getProductImportStatus(importId);

  logger.info('PA01 import status', {
    importId,
    status: status.importStatus,
    linesRead: status.linesRead,
    linesOk: status.linesOk,
    linesError: status.linesError,
  });

  // ─── Still processing ──────────────────────────────────────────────────────
  // SENT = delivered to operator, awaiting integration into catalog.
  // Products must be accepted/integrated before offers can reference them.
  if (status.importStatus === 'WAITING' || status.importStatus === 'RUNNING' || status.importStatus === 'SENT') {
    const elapsed = Math.round((Date.now() - new Date(uploadedAt).getTime()) / 60000);
    logger.info(`Import status: ${status.importStatus} (${elapsed} min elapsed). Check again later.`);
    return;
  }

  // ─── Complete — log errors if any ──────────────────────────────────────────
  if (status.linesError > 0 && status.hasTransformationErrorReport) {
    logger.warn(`PA01 completed with ${status.linesError} transformation errors`);
    try {
      const errData = await mirakl.getTransformationErrorReport(importId);
      const lines = errData.split('\n');
      const headers = lines[0].split(';').map((h) => h.replace(/"/g, ''));
      const errColIdx = headers.findIndex((h) => h.toLowerCase() === 'errors');

      if (errColIdx >= 0) {
        const errCounts: Record<string, number> = {};
        for (let i = 1; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          const cols = lines[i].split(';').map((c) => c.replace(/^"|"$/g, ''));
          const msg = cols[errColIdx] || '(empty)';
          errCounts[msg] = (errCounts[msg] ?? 0) + 1;
        }
        logger.warn('Error summary:');
        for (const [msg, count] of Object.entries(errCounts).sort((a, b) => b[1] - a[1])) {
          logger.warn(`  [${count}x] ${msg.substring(0, 200)}`);
        }
      }
    } catch (err) {
      logger.error('Could not fetch transformation error report', { error: String(err) });
    }
  }

  if (status.linesOk === 0) {
    logger.error('PA01 import produced zero successful lines. Fix errors and re-sync.');
    state.write({ ...current, pendingProductImport: null });
    return;
  }

  logger.info(`PA01 complete: ${status.linesOk}/${status.linesRead} lines succeeded`);

  // ─── Upload OF01 (offers) ──────────────────────────────────────────────────
  if (offersCsvPath) {
    logger.info('Uploading offers to Mirakl OF01...', { path: offersCsvPath });
    const offerImportId = await mirakl.uploadOffersFile(offersCsvPath);
    logger.info('OF01 upload accepted', { importId: offerImportId });

    // Offer imports are fast — poll with existing 10s interval
    const offerResult = await mirakl.pollUntilDone(offerImportId, 'offers');
    logger.info('OF01 import result', {
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
    logger.info('No offers CSV to upload.');
  }

  // ─── Clear pending state ───────────────────────────────────────────────────
  state.write({ ...current, pendingProductImport: null });
  state.markSuccess();
  logger.info('Import workflow complete.');
}
