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
}

export function loadConfig(): AppConfig {
  const root = path.resolve(__dirname, '..');

  const storeDomain = requireEnv('SHOPIFY_STORE_DOMAIN');
  const apiVersion = optionalEnv('SHOPIFY_API_VERSION', '2024-01') ?? '2024-01';

  // Normalise domain — strip protocol if accidentally included
  const cleanDomain = storeDomain.replace(/^https?:\/\//, '');

  const baseUrl = requireEnv('MIRAKL_BASE_URL').replace(/\/$/, '');

  return {
    shopify: {
      storeDomain: cleanDomain,
      adminAccessToken: requireEnv('SHOPIFY_ADMIN_ACCESS_TOKEN'),
      apiVersion,
      graphqlEndpoint: `https://${cleanDomain}/admin/api/${apiVersion}/graphql.json`,
      restBaseUrl:     `https://${cleanDomain}/admin/api/${apiVersion}`,
      webhookSecret:   optionalEnv('SHOPIFY_WEBHOOK_SECRET', '') ?? '',
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
