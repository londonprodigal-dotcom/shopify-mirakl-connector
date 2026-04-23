import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { MappingConfig } from './types';

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
        `  Copy .env.example to .env and fill in all required values.`
    );
  }
  return value.trim();
}

function optionalEnv(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

export interface AppConfig {
  shopify: {
    storeDomain: string;
    adminAccessToken: string;
    apiVersion: string;
    graphqlEndpoint: string;
    restBaseUrl: string;     // https://<domain>/admin/api/<version>
    webhookSecret: string;   // SHOPIFY_WEBHOOK_SECRET — signs incoming webhooks
    // All shared secrets that may have signed an incoming webhook. Two
    // Shopify apps are registered on Louche (custom app + OAuth app) and
    // each signs its own webhooks, so the verifier must try both.
    webhookSecrets: string[];
    clientId: string | undefined;       // SHOPIFY_CLIENT_ID — for OAuth client credentials flow
    clientSecret: string | undefined;   // SHOPIFY_CLIENT_SECRET — for OAuth client credentials flow
  };
  mirakl: {
    baseUrl: string;
    apiKey: string;
    shopId: string | undefined;
  };
  paths: {
    root: string;
    templates: string;
    state: string;
    reports: string;
    output: string;
  };
  server: {
    port: number;
  };
  /** Base URL for the image proxy (e.g. https://connector.up.railway.app). When set, image URLs are rewritten to go through /img?url= proxy for DPI compliance. */
  imageProxyBaseUrl: string | undefined;
  hardening: {
    databaseUrl: string;
    stockBuffer: number;
    stockHoldbackLastN: number;
    alertWebhookUrl: string | undefined;
    alertEmailTo: string | undefined;
    resendApiKey: string | undefined;
    resendFrom: string | undefined;
    reconcileStockIntervalMs: number;
    reconcileOrderIntervalMs: number;
    batchSyncIntervalMs: number;
    fullAuditHourUtc: number;
    workerId: string;
    jobPollIntervalMs: number;
    jobStaleTimeoutMs: number;
    queueBacklogWarn: number;
    queueBacklogCrit: number;
    reconcileStaleMinutes: number;
    watchdogUrls: Array<{ url: string; name: string; staleHours: number; timestampField: string }>;
    driftAlertThreshold: number;
    driftCriticalCount: number;
    degradedMode: boolean;
  };
}

/**
 * Parse WATCHDOG_URLS env var.
 * Format: "name|url|staleHours|timestampField;name2|url2|..."
 * Example: "warehouse|https://web-prod.up.railway.app/health|26|db_last_modified"
 */
function parseWatchdogUrls(raw: string | undefined): Array<{ url: string; name: string; staleHours: number; timestampField: string }> {
  if (!raw) return [];
  return raw.split(';').filter(Boolean).map((entry) => {
    const [name, url, staleHours, timestampField] = entry.split('|');
    return { name: name ?? 'unknown', url: url ?? '', staleHours: parseFloat(staleHours ?? '26'), timestampField: timestampField ?? 'db_last_modified' };
  });
}

export function loadConfig(): AppConfig {
  const root = path.resolve(__dirname, '..');

  const storeDomain = requireEnv('SHOPIFY_STORE_DOMAIN');
  const apiVersion = optionalEnv('SHOPIFY_API_VERSION', '2024-01') ?? '2024-01';

  // Normalise domain — strip protocol if accidentally included
  const cleanDomain = storeDomain.replace(/^https?:\/\//, '');

  const baseUrl = requireEnv('MIRAKL_BASE_URL').replace(/\/$/, '');

  const primaryWebhookSecret = optionalEnv('SHOPIFY_WEBHOOK_SECRET') ?? optionalEnv('SHOPIFY_CLIENT_SECRET') ?? '';
  const clientSecret = optionalEnv('SHOPIFY_CLIENT_SECRET');
  const webhookSecretsSet = new Set<string>();
  if (primaryWebhookSecret) webhookSecretsSet.add(primaryWebhookSecret);
  if (clientSecret) webhookSecretsSet.add(clientSecret);

  return {
    shopify: {
      storeDomain: cleanDomain,
      adminAccessToken: optionalEnv('SHOPIFY_ADMIN_ACCESS_TOKEN', '') ?? '',
      apiVersion,
      graphqlEndpoint: `https://${cleanDomain}/admin/api/${apiVersion}/graphql.json`,
      restBaseUrl:     `https://${cleanDomain}/admin/api/${apiVersion}`,
      webhookSecret:   primaryWebhookSecret,
      webhookSecrets:  Array.from(webhookSecretsSet),
      clientId:        optionalEnv('SHOPIFY_CLIENT_ID'),
      clientSecret,
    },
    mirakl: {
      baseUrl,
      apiKey: requireEnv('MIRAKL_API_KEY'),
      shopId: optionalEnv('MIRAKL_SHOP_ID'),
    },
    paths: {
      root,
      templates: path.join(root, 'templates'),
      state: path.join(root, 'state'),
      reports: path.join(root, 'reports'),
      output: path.join(root, 'output'),
    },
    server: {
      port: parseInt(optionalEnv('PORT', '3000') ?? '3000', 10),
    },
    imageProxyBaseUrl: optionalEnv('IMAGE_PROXY_BASE_URL'),
    hardening: {
      databaseUrl: optionalEnv('DATABASE_URL', '') ?? '',
      stockBuffer: parseInt(optionalEnv('STOCK_BUFFER', '2') ?? '2', 10),
      stockHoldbackLastN: parseInt(optionalEnv('STOCK_HOLDBACK_LAST_N', '7') ?? '7', 10),
      alertWebhookUrl: optionalEnv('ALERT_WEBHOOK_URL'),
      alertEmailTo: optionalEnv('ALERT_EMAIL_TO'),
      resendApiKey: optionalEnv('RESEND_API_KEY'),
      resendFrom: optionalEnv('RESEND_FROM'),
      reconcileStockIntervalMs: parseInt(optionalEnv('RECONCILE_STOCK_INTERVAL_MS', '900000') ?? '900000', 10),   // 15 min
      reconcileOrderIntervalMs: parseInt(optionalEnv('RECONCILE_ORDER_INTERVAL_MS', '600000') ?? '600000', 10),   // 10 min
      batchSyncIntervalMs: parseInt(optionalEnv('BATCH_SYNC_INTERVAL_MS', '3600000') ?? '3600000', 10),           // 1 hour
      fullAuditHourUtc: parseInt(optionalEnv('FULL_AUDIT_HOUR_UTC', '3') ?? '3', 10),
      workerId: optionalEnv('WORKER_ID', `worker-${process.pid}`) ?? `worker-${process.pid}`,
      jobPollIntervalMs: parseInt(optionalEnv('JOB_POLL_INTERVAL_MS', '5000') ?? '5000', 10),
      jobStaleTimeoutMs: parseInt(optionalEnv('JOB_STALE_TIMEOUT_MS', '600000') ?? '600000', 10),                 // 10 min
      queueBacklogWarn: parseInt(optionalEnv('QUEUE_BACKLOG_WARN', '50') ?? '50', 10),
      queueBacklogCrit: parseInt(optionalEnv('QUEUE_BACKLOG_CRIT', '200') ?? '200', 10),
      reconcileStaleMinutes: parseInt(optionalEnv('RECONCILE_STALE_MINUTES', '30') ?? '30', 10),
      watchdogUrls: parseWatchdogUrls(optionalEnv('WATCHDOG_URLS')),
      driftAlertThreshold: parseInt(optionalEnv('DRIFT_ALERT_THRESHOLD', '5') ?? '5', 10),
      driftCriticalCount: parseInt(optionalEnv('DRIFT_CRITICAL_COUNT', '20') ?? '20', 10),
      degradedMode: (optionalEnv('DEGRADED_MODE', 'false') ?? 'false') === 'true',
    },
  };
}

export function loadMappingConfig(configPath?: string): MappingConfig {
  const filePath = configPath ?? path.resolve(__dirname, '..', 'mapping.yaml');

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Mapping config not found: ${filePath}\n` +
        `  The mapping.yaml file is required. See the repository root for the example.`
    );
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = yaml.load(raw) as MappingConfig;

  // Ensure required sections exist
  parsed.defaults = parsed.defaults ?? {};
  parsed.categoryMappings = parsed.categoryMappings ?? {};
  parsed.tagMappings = parsed.tagMappings ?? {};
  parsed.colourFacetMappings = parsed.colourFacetMappings ?? {};
  parsed.optionAliases = parsed.optionAliases ?? { color: ['Color'], size: ['Size'] };
  parsed.productFieldMappings = parsed.productFieldMappings ?? {};
  parsed.offerFieldMappings = parsed.offerFieldMappings ?? {};
  parsed.categoryAttributes = parsed.categoryAttributes ?? {};

  return parsed;
}
