import * as fs from 'fs';
import * as path from 'path';
import FormData from 'form-data';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { AppConfig } from './config';
import { MiraklImportStatus, MiraklOrder } from './types';
import { logger } from './logger';

// Mirakl import status strings returned by the API
// SENT = delivered to operator, awaiting catalog integration (products only)
type RawStatus = 'WAITING' | 'RUNNING' | 'SENT' | 'COMPLETE' | 'FAILED';

const POLL_INTERVAL_MS = 10_000;   // 10 seconds between polls
const POLL_TIMEOUT_MS  = 7_200_000; // 2 hours max wait (large catalogs can be slow)

// ─── MiraklClient ─────────────────────────────────────────────────────────────

export class MiraklClient {
  private readonly http: AxiosInstance;
  private readonly shopId: string | undefined;
  private readonly reportsDir: string;

  constructor(config: AppConfig) {
    this.shopId = config.mirakl.shopId;
    this.reportsDir = config.paths.reports;

    this.http = axios.create({
      baseURL: config.mirakl.baseUrl,
      headers: {
        // Mirakl uses bare API key, not Bearer
        Authorization: config.mirakl.apiKey,
        Accept: 'application/json',
      },
      timeout: 300_000, // 5 min — large CSV uploads can be slow
    });

    // Log all outgoing requests at debug level
    this.http.interceptors.request.use((req) => {
      logger.debug('Mirakl →', { method: req.method?.toUpperCase(), url: req.url });
      return req;
    });

    // Retry on 429 (rate limit) with exponential backoff
    this.http.interceptors.response.use(
      (res) => res,
      async (err: AxiosError) => {
        const status = err.response?.status;
        const config = err.config as typeof err.config & { _retryCount?: number };

        if (status === 429 && config && (config._retryCount ?? 0) < 3) {
          config._retryCount = (config._retryCount ?? 0) + 1;
          const delay = config._retryCount * 30_000; // 30s, 60s, 90s
          logger.warn('Mirakl 429 rate limited, backing off', { retry: config._retryCount, delayMs: delay });
          await new Promise(r => setTimeout(r, delay));
          return this.http.request(config);
        }

        const body = JSON.stringify(err.response?.data ?? err.message).slice(0, 500);
        logger.error('Mirakl API error', { status, body });
        return Promise.reject(err);
      }
    );
  }

  // ─── Shop ID query param ────────────────────────────────────────────────────

  private shopParam(): Record<string, string> {
    return this.shopId ? { shop_id: this.shopId } : {};
  }

  // ─── OF01 – upload offers file ──────────────────────────────────────────────

  /**
   * Upload a CSV file to the Mirakl OF01 (offer import) endpoint.
   * Returns the import_id for tracking.
   */
  async uploadOffersFile(csvPath: string): Promise<string | number> {
    logger.info('Uploading offers file to Mirakl OF01', { file: csvPath });

    const form = new FormData();
    form.append('file', fs.createReadStream(csvPath), {
      filename: path.basename(csvPath),
      contentType: 'text/csv',
    });

    const { data } = await this.http.post<{ import_id: string | number }>(
      '/api/offers/imports',
      form,
      {
        headers: {
          ...form.getHeaders(),
        },
        params: { ...this.shopParam(), import_mode: 'NORMAL' },
      }
    );

    const importId = data.import_id;
    logger.info('Offers upload accepted', { importId });
    return importId;
  }

  // ─── PA01 – upload products file ────────────────────────────────────────────

  /**
   * Upload a CSV file to the Mirakl product (PA01) endpoint.
   * Returns the import_id for tracking.
   */
  async uploadProductsFile(csvPath: string): Promise<string | number> {
    logger.info('Uploading products file to Mirakl PA01', { file: csvPath });

    const form = new FormData();
    form.append('file', fs.createReadStream(csvPath), {
      filename: path.basename(csvPath),
      contentType: 'text/csv',
    });

    const { data } = await this.http.post<{ import_id: string | number }>(
      '/api/products/imports',
      form,
      {
        headers: {
          ...form.getHeaders(),
        },
        params: this.shopParam(),
      }
    );

    const importId = data.import_id;
    logger.info('Products upload accepted', { importId });
    return importId;
  }

  // ─── Check PA01 import status (single call, no polling) ────────────────────

  async getProductImportStatus(importId: string | number): Promise<{
    importStatus: string;
    linesRead: number;
    linesOk: number;
    linesError: number;
    hasTransformationErrorReport: boolean;
    raw: any;
  }> {
    const { data } = await this.http.get(`/api/products/imports/${importId}`, {
      params: this.shopParam(),
    });
    return {
      importStatus: data.import_status ?? data.status ?? 'UNKNOWN',
      linesRead:    data.transform_lines_read ?? data.lines_read ?? 0,
      linesOk:      data.transform_lines_in_success ?? data.lines_in_success ?? 0,
      linesError:   data.transform_lines_in_error ?? data.lines_in_error ?? 0,
      hasTransformationErrorReport: data.has_transformation_error_report ?? false,
      raw: data,
    };
  }

  // ─── Fetch PA01 transformation error report ───────────────────────────────

  async getTransformationErrorReport(importId: string | number): Promise<string> {
    const { data } = await this.http.get<string>(
      `/api/products/imports/${importId}/transformation_error_report`,
      { params: this.shopParam(), responseType: 'text' }
    );
    return String(data);
  }

  // ─── Poll for completion ────────────────────────────────────────────────────

  /**
   * Poll the import status endpoint until COMPLETE or FAILED (or timeout).
   */
  async pollUntilDone(
    importId: string | number,
    endpoint: 'offers' | 'products'
  ): Promise<MiraklImportStatus> {
    const url = `/api/${endpoint}/imports/${importId}`;
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    logger.info('Polling Mirakl import status', { importId, endpoint });

    while (Date.now() < deadline) {
      const { data } = await this.http.get<MiraklImportStatus>(url, {
        params: this.shopParam(),
      });

      // OF01 uses "status", PA01 uses "import_status"
      const status = ((data as any).status ?? (data as any).import_status ?? 'WAITING') as RawStatus;

      logger.info('Import status', {
        importId,
        status,
        linesRead: data.lines_read ?? (data as any).transform_lines_read,
        linesOk: data.lines_in_success ?? (data as any).transform_lines_in_success,
        linesError: data.lines_in_error ?? (data as any).transform_lines_in_error,
      });

      if (status === 'COMPLETE' || status === 'FAILED') {
        return data;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    throw new Error(
      `Mirakl import ${importId} did not finish within ${POLL_TIMEOUT_MS / 1000}s`
    );
  }

  // ─── Download error report ──────────────────────────────────────────────────

  /**
   * Fetch the per-line error report for a completed (or failed) import
   * and save it to /reports/<timestamp>-<importId>-errors.csv
   */
  async downloadErrorReport(
    importId: string | number,
    endpoint: 'offers' | 'products'
  ): Promise<string> {
    const url = `/api/${endpoint}/imports/${importId}/error_report`;
    logger.info('Downloading error report', { importId, url });

    const { data } = await this.http.get<string>(url, {
      params: this.shopParam(),
      responseType: 'text',
    });

    if (!fs.existsSync(this.reportsDir)) {
      fs.mkdirSync(this.reportsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename  = `${timestamp}-${importId}-${endpoint}-errors.csv`;
    const outPath   = path.join(this.reportsDir, filename);

    fs.writeFileSync(outPath, data, 'utf8');
    logger.info('Error report saved', { path: outPath });
    return outPath;
  }

  // ─── Push a single-SKU stock update (used by inventory webhook) ────────────

  /**
   * Build a minimal OF01 CSV in memory and upload it immediately.
   * Returns the import_id. Callers should verify completion via pollUntilDone().
   */
  async pushStockUpdate(sku: string, quantity: number): Promise<string | number> {
    logger.info('Pushing stock update to Mirakl', { sku, quantity });

    // Build a minimal two-row CSV (header + one data row) entirely in memory
    const csvContent = `offer-sku\tquantity\tupdate-delete\r\n${sku}\t${quantity}\tU\r\n`;
    const csvBuffer  = Buffer.from('\uFEFF' + csvContent, 'utf8');

    const form = new FormData();
    form.append('file', csvBuffer, {
      filename:    `stock-${sku}-${Date.now()}.csv`,
      contentType: 'text/csv',
    });

    const { data } = await this.http.post<{ import_id: string | number }>(
      '/api/offers/imports',
      form,
      { headers: { ...form.getHeaders() }, params: { ...this.shopParam(), import_mode: 'NORMAL' } }
    );

    logger.info('Stock update accepted by Mirakl', { importId: data.import_id, sku });
    return data.import_id;
  }

  // ─── Fetch a single Mirakl order by ID (OR11) ────────────────────────────

  async getOrder(orderId: string): Promise<MiraklOrder> {
    const { data } = await this.http.get<{ orders: MiraklOrder[] }>('/api/orders', {
      params: { ...this.shopParam(), order_ids: orderId },
    });

    const order = data.orders?.[0];
    if (!order) throw new Error(`Mirakl order not found: ${orderId}`);
    return order;
  }

  // ─── Fetch all offers (paginated) ──────────────────────────────────────────

  async fetchAllOffers(): Promise<Array<{ sku: string; quantity: number; price: number }>> {
    const offers: Array<{ sku: string; quantity: number; price: number }> = [];
    let offset = 0;
    const max = 100;

    while (true) {
      const { data } = await this.http.get('/api/offers', {
        params: { ...this.shopParam(), max, offset },
      });
      const batch = data.offers ?? [];
      for (const offer of batch) {
        offers.push({
          sku: offer.sku ?? offer.offer_sku ?? '',
          quantity: offer.quantity ?? 0,
          price: offer.price ?? 0,
        });
      }
      if (batch.length < max) break;
      offset += max;
    }

    return offers;
  }

  // ─── CM11 – Export Source Product Data Sheet status ─────────────────────────

  /**
   * Fetch product integration statuses via CM11.
   * Returns per-product LIVE/NOT_LIVE status with rejection details.
   * Use updatedSince for delta exports (recommended every 15 min).
   */
  async fetchProductStatuses(updatedSince?: string): Promise<{
    live: number;
    notLive: number;
    errors: Record<string, number>;
    products: Array<{ sku: string; ean: string; status: string; error?: string }>;
  }> {
    const params: Record<string, string | number> = { max: 100 };
    if (updatedSince) params.updated_since = updatedSince;

    let live = 0, notLive = 0;
    const errorCounts: Record<string, number> = {};
    const products: Array<{ sku: string; ean: string; status: string; error?: string }> = [];
    let offset = 0;

    while (true) {
      params.offset = offset;
      const { data } = await this.http.get('/api/mcm/products/sources/status/export', { params });

      const items = Object.values(data).filter(
        (x): x is Record<string, unknown> => typeof x === 'object' && x !== null && 'status' in x
      );
      if (items.length === 0) break;

      for (const p of items) {
        const sku = String(p.provider_unique_identifier ?? '');
        const ean = (p.unique_identifiers as Array<{ code: string; value: string }> | undefined)
          ?.find(u => u.code === 'EAN')?.value ?? '';
        const status = String(p.status ?? '');

        if (status === 'LIVE') {
          live++;
          products.push({ sku, ean, status });
        } else {
          notLive++;
          const errors = p.errors as Array<{ rejection_details?: { message?: string }; message?: string }> | undefined;
          const detail = errors?.[0]?.rejection_details?.message ?? errors?.[0]?.message ?? 'unknown';
          // Group by first 80 chars of error
          const key = detail.substring(0, 80);
          errorCounts[key] = (errorCounts[key] ?? 0) + 1;
          products.push({ sku, ean, status, error: detail.substring(0, 200) });
        }
      }

      if (items.length < 100) break;
      offset += 100;

      // Rate limit: pause between pages
      await new Promise(r => setTimeout(r, 2000));
    }

    return { live, notLive, errors: errorCounts, products };
  }

  // ─── Fetch recent orders (paginated) ─────────────────────────────────────────

  async fetchRecentOrders(since: string): Promise<MiraklOrder[]> {
    const orders: MiraklOrder[] = [];
    let offset = 0;
    const max = 50;
    const orderStates = 'WAITING_DEBIT_PAYMENT,WAITING_ACCEPTANCE,SHIPPING,SHIPPED,TO_COLLECT,RECEIVED';

    while (true) {
      const { data } = await this.http.get('/api/orders', {
        params: { ...this.shopParam(), max, offset, start_date: since, order_state_codes: orderStates },
      });
      const batch = data.orders ?? [];
      orders.push(...batch);
      if (batch.length < max) break;
      offset += max;
    }

    return orders;
  }

  // ─── Convenience: upload + wait + handle errors ────────────────────────────

  async importAndWait(
    csvPath: string,
    type: 'offers' | 'products'
  ): Promise<MiraklImportStatus> {
    const importId =
      type === 'offers'
        ? await this.uploadOffersFile(csvPath)
        : await this.uploadProductsFile(csvPath);

    const status = await this.pollUntilDone(importId, type);

    if (status.lines_in_error > 0 || status.status === 'FAILED') {
      logger.warn('Import completed with errors – fetching error report', {
        importId,
        linesInError: status.lines_in_error,
      });
      try {
        const reportPath = await this.downloadErrorReport(importId, type);
        logger.warn('Review error report', { reportPath });
      } catch (err) {
        logger.error('Could not download error report', { error: String(err) });
      }
    }

    return status;
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
