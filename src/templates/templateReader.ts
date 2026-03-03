import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import { Template, TemplateType } from '../types';
import { logger } from '../logger';

const TEMPLATE_NOT_FOUND_HELP = `
No Mirakl template files found in the /templates directory.

To download the templates from Mirakl back office:
  1. Log into your Mirakl seller back office
  2. Go to: My Inventory → Price and Stock → File Imports
  3. Click "Download template" and save as templates/products-and-offers-template.xlsx
  4. Re-run this command.

See README.md § "Downloading Mirakl Templates" for full instructions.
`.trim();

// ─── File detection ───────────────────────────────────────────────────────────

function detectType(filename: string): TemplateType | null {
  const lower = filename.toLowerCase();
  if (lower.includes('product') && lower.includes('offer')) return 'combined';
  if (lower.includes('import'))   return 'combined';
  if (lower.includes('product'))  return 'products';
  if (lower.includes('offer'))    return 'offers';
  if (lower.includes('price'))    return 'offers'; // prices-en_GB template
  if (lower.includes('stock'))    return 'offers'; // stock-en_GB template
  return null;
}

// ─── Mirakl templates have two header rows:
//   Row 1: Human-readable display names  ("Product Title", "Offer Price")
//   Row 2: Machine-readable API codes    ("product_title", "price")
//
// We must use Row 2 as the actual CSV column headers.
// Detection: if a row's cells contain spaces it's a display row → skip it.

function looksLikeDisplayRow(cells: string[]): boolean {
  const nonEmpty = cells.filter(Boolean);
  if (nonEmpty.length === 0) return false;
  const withSpaces = nonEmpty.filter(c => c.includes(' ')).length;
  return withSpaces / nonEmpty.length > 0.4; // >40% of cells have spaces → display row
}

// ─── Header extraction ────────────────────────────────────────────────────────

async function headersFromExcel(filePath: string): Promise<string[]> {
  const workbook = new ExcelJS.Workbook();
  // Only read the first 3 rows for performance on large templates
  await (workbook.xlsx as ExcelJS.Xlsx & { readFile(path: string, opts?: object): Promise<ExcelJS.Workbook> })
    .readFile(filePath, { sheetRows: 3 });

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error(`Excel file has no worksheets: ${filePath}`);

  const candidates: string[][] = [];

  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: false }, (cell) => {
      cells.push(String(cell.value ?? '').trim());
    });
    if (cells.filter(Boolean).length >= 2) {
      candidates.push(cells);
    }
  });

  if (candidates.length === 0) {
    throw new Error(`Could not find header row in Excel template: ${filePath}`);
  }

  // If first candidate looks like display names, prefer the second row
  let headers = candidates[0];
  if (looksLikeDisplayRow(headers) && candidates.length > 1) {
    logger.debug('Row 1 appears to be display names — using Row 2 as machine-readable headers');
    headers = candidates[1];
  }

  // Trim trailing empty entries
  while (headers.length > 0 && headers[headers.length - 1] === '') headers.pop();
  return headers;
}

function headersFromCsv(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const firstLine = content.split('\n')[0] ?? '';
  let delimiter = ',';
  if (firstLine.includes('\t')) delimiter = '\t';
  else if (firstLine.includes(';')) delimiter = ';';

  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== '');
  for (const line of lines.slice(0, 5)) {
    const cells = line.split(delimiter).map((c) => c.trim().replace(/^["']|["']$/g, ''));
    if (cells.filter(Boolean).length >= 2) {
      if (looksLikeDisplayRow(cells) && lines.length > 1) continue;
      return cells;
    }
  }
  throw new Error(`Could not find header row in CSV template: ${filePath}`);
}

async function readHeaders(filePath: string): Promise<string[]> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') return headersFromExcel(filePath);
  if (ext === '.csv' || ext === '.txt') return headersFromCsv(filePath);
  throw new Error(`Unsupported template format: ${ext}. Use .xlsx or .csv files.`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface TemplateSet {
  products: Template | null;
  offers: Template | null;
  combined: Template | null;
}

export async function loadTemplates(templatesDir: string): Promise<TemplateSet> {
  if (!fs.existsSync(templatesDir)) fs.mkdirSync(templatesDir, { recursive: true });

  const files = fs
    .readdirSync(templatesDir)
    .filter((f) => ['.xlsx', '.xls', '.csv', '.txt'].includes(path.extname(f).toLowerCase()))
    .filter((f) => !f.startsWith('~$'));

  if (files.length === 0) throw new Error(TEMPLATE_NOT_FOUND_HELP);

  const result: TemplateSet = { products: null, offers: null, combined: null };

  for (const file of files) {
    const filePath = path.join(templatesDir, file);
    const type = detectType(file);

    if (type === null) {
      logger.warn(`Skipping unrecognised template (name must contain "product", "offer", or "import"): ${file}`);
      continue;
    }

    logger.info(`Loading ${type} template: ${file}`);
    const headers = await readHeaders(filePath);
    logger.info(`  ${headers.length} columns detected. First: ${headers[0]}, Last: ${headers[headers.length - 1]}`);

    const template: Template = { type, filePath, headers };

    if (type === 'combined') {
      result.combined = template;
      result.products = result.products ?? { ...template, type: 'products' };
      result.offers   = result.offers   ?? { ...template, type: 'offers' };
    } else if (type === 'products') {
      result.products = template;
    } else {
      result.offers = template;
    }
  }

  if (!result.products && !result.offers && !result.combined) {
    throw new Error(TEMPLATE_NOT_FOUND_HELP);
  }

  return result;
}
