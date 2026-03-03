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
  3. Click "Download template" for:
       - "Products" template  →  save as templates/products-template.xlsx
       - "Offers" template    →  save as templates/offers-template.xlsx
     (If a combined "Products + Offers" template is available, save as
       templates/import-template.xlsx)
  4. Re-run this command.

See README.md § "Downloading Mirakl Templates" for full instructions.
`.trim();

// ─── File detection ───────────────────────────────────────────────────────────

function detectType(filename: string): TemplateType | null {
  const lower = filename.toLowerCase();
  if (lower.includes('product') && lower.includes('offer')) return 'combined';
  if (lower.includes('import'))  return 'combined';
  if (lower.includes('product')) return 'products';
  if (lower.includes('offer'))   return 'offers';
  return null;
}

// ─── Header extraction ────────────────────────────────────────────────────────

async function headersFromExcel(filePath: string): Promise<string[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error(`Excel file has no worksheets: ${filePath}`);
  }

  // Mirakl templates sometimes have title rows above headers.
  // Find the first row with ≥ 2 non-empty cells.
  let headerRow: ExcelJS.Row | null = null;
  sheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (headerRow !== null || rowNum > 5) return;
    const nonEmpty = row.values
      ? (row.values as (ExcelJS.CellValue | null)[]).filter(
          (v) => v !== null && v !== undefined && String(v).trim() !== ''
        )
      : [];
    if (nonEmpty.length >= 2) {
      headerRow = row;
    }
  });

  if (!headerRow) {
    throw new Error(`Could not find header row in Excel template: ${filePath}`);
  }

  const row = headerRow as ExcelJS.Row;
  const headers: string[] = [];
  row.eachCell({ includeEmpty: false }, (cell) => {
    headers.push(String(cell.value ?? '').trim());
  });

  // Remove trailing empty entries
  while (headers.length > 0 && headers[headers.length - 1] === '') {
    headers.pop();
  }

  return headers;
}

function headersFromCsv(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const cleaned = content.replace(/^\uFEFF/, ''); // strip UTF-8 BOM

  // Detect delimiter
  const firstLine = cleaned.split('\n')[0] ?? '';
  let delimiter = ',';
  if (firstLine.includes('\t')) delimiter = '\t';
  else if (firstLine.includes(';')) delimiter = ';';

  const lines = cleaned.split(/\r?\n/).filter((l) => l.trim() !== '');

  for (const line of lines.slice(0, 5)) {
    const cells = line.split(delimiter).map((c) =>
      c.trim().replace(/^["']|["']$/g, '')
    );
    if (cells.filter(Boolean).length >= 2) {
      return cells;
    }
  }

  throw new Error(`Could not find header row in CSV template: ${filePath}`);
}

async function readHeaders(filePath: string): Promise<string[]> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') {
    return headersFromExcel(filePath);
  }
  if (ext === '.csv' || ext === '.txt') {
    return headersFromCsv(filePath);
  }
  throw new Error(
    `Unsupported template format: ${ext}. Use .xlsx or .csv files.`
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface TemplateSet {
  products: Template | null;
  offers: Template | null;
}

export async function loadTemplates(templatesDir: string): Promise<TemplateSet> {
  if (!fs.existsSync(templatesDir)) {
    fs.mkdirSync(templatesDir, { recursive: true });
  }

  const files = fs
    .readdirSync(templatesDir)
    .filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return ['.xlsx', '.xls', '.csv', '.txt'].includes(ext);
    })
    .filter((f) => !f.startsWith('~$')); // ignore Excel temp/lock files

  if (files.length === 0) {
    throw new Error(TEMPLATE_NOT_FOUND_HELP);
  }

  const result: TemplateSet = { products: null, offers: null };

  for (const file of files) {
    const filePath = path.join(templatesDir, file);
    const type = detectType(file);

    if (type === null) {
      logger.warn(
        `Skipping unrecognised template (name must contain "product", "offer", or "import"): ${file}`
      );
      continue;
    }

    logger.info(`Loading ${type} template: ${file}`);
    const headers = await readHeaders(filePath);
    logger.debug(`  Headers (${headers.length}): ${headers.slice(0, 8).join(', ')}…`);

    const template: Template = { type, filePath, headers };

    if (type === 'combined') {
      result.products = result.products ?? { ...template, type: 'products' };
      result.offers   = result.offers   ?? { ...template, type: 'offers' };
    } else if (type === 'products') {
      result.products = template;
    } else {
      result.offers = template;
    }
  }

  if (!result.products && !result.offers) {
    throw new Error(TEMPLATE_NOT_FOUND_HELP);
  }

  return result;
}
