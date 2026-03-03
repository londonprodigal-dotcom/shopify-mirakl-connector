import * as fs from 'fs';
import * as path from 'path';
import { MiraklRow } from '../types';
import { logger } from '../logger';

// ─── Formatting helpers ───────────────────────────────────────────────────────

/**
 * Format a cell value for CSV output.
 * - Numbers: fixed 2 decimal places for prices, integer for quantities
 * - Strings: quoted if they contain delimiter, quote chars, or newlines
 * - null/undefined: empty string
 * - Prevents scientific notation for large integers (e.g. EANs)
 */
function formatCell(value: MiraklRow[string], delimiter: string): string {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  if (typeof value === 'number') {
    // Use toFixed to prevent scientific notation
    const str =
      Number.isInteger(value) ? String(value) : value.toFixed(2);
    return str;
  }

  const str = String(value);

  // Prevent numeric strings (like EANs) from being output in scientific notation
  // by detecting large integers and just returning them as-is
  if (/^\d+$/.test(str) && str.length > 6) {
    // Already a plain integer string — safe
    return quoteIfNeeded(str, delimiter);
  }

  // Detect price-like decimals
  if (/^\d+\.\d+$/.test(str)) {
    // Keep as-is (no scientific notation risk for typical prices)
    return quoteIfNeeded(str, delimiter);
  }

  return quoteIfNeeded(str, delimiter);
}

function quoteIfNeeded(str: string, delimiter: string): string {
  const needsQuoting =
    str.includes(delimiter) ||
    str.includes('"') ||
    str.includes('\n') ||
    str.includes('\r');

  if (needsQuoting) {
    // Escape existing double-quotes by doubling them
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ─── CSV writer ───────────────────────────────────────────────────────────────

export interface CsvWriteOptions {
  /** Column delimiter — defaults to comma */
  delimiter?: string;
  /** Output directory — defaults to ./output */
  outputDir?: string;
  /** Filename without extension — a timestamp prefix is added automatically */
  filename?: string;
  /** Add UTF-8 BOM so Excel opens the file correctly */
  bom?: boolean;
}

/**
 * Write rows to a CSV file, using the provided headers as columns (in order).
 *
 * Returns the absolute path of the written file.
 */
export function writeCsv(
  headers: string[],
  rows: MiraklRow[],
  options: CsvWriteOptions = {}
): string {
  const delimiter = options.delimiter ?? ',';
  const outputDir = options.outputDir ?? path.resolve(__dirname, '..', '..', 'output');
  const bom       = options.bom ?? true;

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const basename  = options.filename ?? 'export';
  const filename  = `${timestamp}-${basename}.csv`;
  const filePath  = path.join(outputDir, filename);

  const lines: string[] = [];

  // Header row
  lines.push(headers.map((h) => quoteIfNeeded(h, delimiter)).join(delimiter));

  // Data rows
  for (const row of rows) {
    const cells = headers.map((h) => formatCell(row[h], delimiter));
    lines.push(cells.join(delimiter));
  }

  const content = lines.join('\r\n') + '\r\n'; // CRLF for Excel compatibility
  const bomPrefix = bom ? '\uFEFF' : '';

  fs.writeFileSync(filePath, bomPrefix + content, 'utf8');

  logger.info(`CSV written: ${filename}`, {
    rows: rows.length,
    columns: headers.length,
    path: filePath,
  });

  return filePath;
}

// ─── Dry-run summary ──────────────────────────────────────────────────────────

/**
 * In dry-run mode: print a table preview of the first N rows to the console.
 */
export function previewCsv(
  headers: string[],
  rows: MiraklRow[],
  label: string,
  previewRows = 5
): void {
  logger.info(`[DRY RUN] ${label}: ${rows.length} rows, ${headers.length} columns`);

  if (rows.length === 0) {
    logger.info('  (no rows to preview)');
    return;
  }

  // Print the first few rows with key columns
  const keyColumns = headers.slice(0, 8); // Show first 8 columns max
  const header = keyColumns.join(' | ');
  const divider = keyColumns.map((h) => '-'.repeat(Math.min(h.length, 20))).join('-+-');

  logger.info(`  ${header}`);
  logger.info(`  ${divider}`);

  for (const row of rows.slice(0, previewRows)) {
    const cells = keyColumns.map((h) => {
      const v = String(row[h] ?? '').slice(0, 20);
      return v.padEnd(Math.min(h.length, 20));
    });
    logger.info(`  ${cells.join(' | ')}`);
  }

  if (rows.length > previewRows) {
    logger.info(`  ... and ${rows.length - previewRows} more rows`);
  }
}
