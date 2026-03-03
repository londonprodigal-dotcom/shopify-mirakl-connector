#!/usr/bin/env node
import { Command } from 'commander';
import { runSync } from './commands/sync';
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

program.parseAsync(process.argv).catch((err) => {
  logger.error('Unexpected CLI error', { error: String(err) });
  process.exit(1);
});
