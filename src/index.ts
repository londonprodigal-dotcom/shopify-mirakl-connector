#!/usr/bin/env node
import { Command } from 'commander';
import { runSync } from './commands/sync';
import { runCheckImport } from './commands/checkImport';
import { loadConfig } from './config';
import { logger } from './logger';

const program = new Command();

program
  .name('mirakl-sync')
  .description('Syncs Shopify products into Debenhams Marketplace via Mirakl')
  .version('1.0.0');

program
  .command('sync')
  .description('Sync products and offers from Shopify to Mirakl')
  .option('--dry-run', 'Generate CSV files locally without uploading to Mirakl', false)
  .option(
    '--incremental',
    'Only sync products updated since the last successful run',
    false
  )
  .option(
    '--stock-only',
    'Only update quantities and prices (no catalog / product attributes)',
    false
  )
  .option(
    '--templates-path <path>',
    'Override the directory containing Mirakl template files (default: ./templates)'
  )
  .action(async (opts: { dryRun: boolean; incremental: boolean; stockOnly: boolean; templatesPath?: string }) => {
    try {
      await runSync({
        dryRun:        opts.dryRun,
        incremental:   opts.incremental,
        stockOnly:     opts.stockOnly,
        templatesPath: opts.templatesPath,
      });
      process.exit(0);
    } catch (err) {
      logger.error('Sync failed', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      process.exit(1);
    }
  });

program
  .command('check-import')
  .description('Check pending PA01 product import status; upload OF01 offers if complete')
  .action(async () => {
    try {
      await runCheckImport();
      process.exit(0);
    } catch (err) {
      logger.error('Check-import failed', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      process.exit(1);
    }
  });

program
  .command('server')
  .description('Start the webhook receiver HTTP server (Shopify inventory + Mirakl orders)')
  .action(async () => {
    try {
      const config = loadConfig();
      const { startServer } = await import('./server');
      await startServer(config);
      // Also start the worker inline so it shares the same deploy as the server
      if (config.hardening.databaseUrl) {
        const { startWorker } = await import('./worker/index');
        await startWorker();
        logger.info('Worker started inline with server');
      }
      // No process.exit — event loop keeps the server alive
    } catch (err) {
      logger.error('Server failed to start', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  });

program
  .command('worker')
  .description('Start the background job worker (processes queued stock updates, order creation, etc.)')
  .action(async () => {
    try {
      const { startWorker } = await import('./worker/index');
      await startWorker();
      // No process.exit — poll loop keeps the worker alive
    } catch (err) {
      logger.error('Worker failed to start', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  });

// Admin commands
const admin = program.command('admin').description('Admin tools');

admin
  .command('replay <jobId>')
  .description('Re-enqueue a failed/dead job')
  .action(async (jobId: string) => {
    const { replayJob } = await import('./admin/cli');
    await replayJob(jobId);
    const { closePool } = await import('./db/pool');
    await closePool();
  });

admin
  .command('replay-all-dead')
  .description('Re-enqueue all dead-letter jobs')
  .action(async () => {
    const { replayAllDead } = await import('./admin/cli');
    await replayAllDead();
    const { closePool } = await import('./db/pool');
    await closePool();
  });

admin
  .command('reconcile-stock')
  .description('Trigger stock reconciliation')
  .action(async () => {
    const { reconcileStock } = await import('./admin/cli');
    await reconcileStock();
    const { closePool } = await import('./db/pool');
    await closePool();
  });

admin
  .command('reconcile-orders')
  .description('Trigger order reconciliation')
  .action(async () => {
    const { reconcileOrders } = await import('./admin/cli');
    await reconcileOrders();
    const { closePool } = await import('./db/pool');
    await closePool();
  });

admin
  .command('queue-status')
  .description('Show queue status')
  .action(async () => {
    const { queueStatus } = await import('./admin/cli');
    await queueStatus();
    const { closePool } = await import('./db/pool');
    await closePool();
  });

admin
  .command('compare-stock')
  .description('Show stock drift')
  .action(async () => {
    const { compareStock } = await import('./admin/cli');
    await compareStock();
    const { closePool } = await import('./db/pool');
    await closePool();
  });

admin
  .command('incident-report')
  .description('Generate 24h incident report')
  .action(async () => {
    const { incidentReport } = await import('./admin/cli');
    await incidentReport();
    const { closePool } = await import('./db/pool');
    await closePool();
  });

admin
  .command('purge-completed')
  .description('Delete old completed jobs')
  .option('-d, --days <days>', 'Days to keep', '7')
  .action(async (opts: { days: string }) => {
    const { purgeCompleted } = await import('./admin/cli');
    await purgeCompleted(parseInt(opts.days, 10));
    const { closePool } = await import('./db/pool');
    await closePool();
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error('Unexpected CLI error', { error: String(err) });
  process.exit(1);
});
