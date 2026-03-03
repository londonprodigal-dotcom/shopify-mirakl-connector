# Shopify → Mirakl Connector

Syncs products and offers from a Shopify store into the Debenhams Marketplace via Mirakl's Seller APIs.

## Features

- **Template-driven** — reads exact column headers from Mirakl-generated Excel/CSV templates; outputs matching files
- **Dry-run mode** — previews the generated CSV without uploading anything
- **Incremental sync** — only re-exports products updated since the last successful run
- **Stock-only mode** — updates quantities/prices only (fast, no catalog changes)
- **Automatic error reports** — downloads and saves Mirakl error reports to `/reports/`
- **Idempotent** — re-running does not duplicate SKUs; Mirakl upserts by seller article ID
- **No scientific notation** — EANs, large IDs and decimals are formatted safely

---

## Prerequisites

- Node.js ≥ 20
- A Shopify store with an **Admin API access token** (scopes: `read_products`, `read_inventory`)
- A Mirakl **Seller API key** (from _My Account → API Key_ in your Mirakl back office)
- The Mirakl-generated **template files** (see below)

---

## Setup

### 1. Install dependencies

```bash
cd shopify-mirakl-connector
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```env
SHOPIFY_STORE_DOMAIN=louchelondon.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxxxxxxxxxxx

MIRAKL_BASE_URL=https://debenhams.mirakl.net
MIRAKL_API_KEY=your-mirakl-seller-api-key
MIRAKL_SHOP_ID=            # leave blank if you only have one shop
```

### 3. Download Mirakl templates

This connector is **template-first**: you must download the official Mirakl import templates and place them in the `/templates` directory. Without them the tool will not run.

#### How to download

1. Log into your Mirakl **Seller Back Office** at `https://debenhams.mirakl.net`
2. Navigate to **My Inventory → Price and Stock → File Imports**
3. Click **"Download template"** for:
   - **Products template** → save as `templates/products-template.xlsx`
   - **Offers template** → save as `templates/offers-template.xlsx`

   > If only a combined "Products + Offers" template is available, save it as `templates/import-template.xlsx`

4. The template file names must contain the words `product`, `offer`, or `import` so the tool can detect which is which.

#### Template file naming convention

| Template type | Acceptable filenames |
|---|---|
| Products catalog | `products-template.xlsx`, `products.csv`, `product_template.xlsx`, … |
| Offers (price/stock) | `offers-template.xlsx`, `offers.csv`, `offer_template.xlsx`, … |
| Combined | `import-template.xlsx`, `products-offers.xlsx`, … |

### 4. Configure attribute mapping

Edit `mapping.yaml` to match your store's product types and Mirakl's category codes:

```yaml
categoryMappings:
  "Dresses": "FA_DRESSES"   # Shopify product_type → Mirakl category code
  "Tops": "FA_TOPS"
  "_default": "FA_WOMENSWEAR"  # fallback category

defaults:
  state_code: "11"           # 11 = New condition
  leadtime_to_ship: 3        # working days
  currency: "GBP"
```

Mirakl category codes are visible in your back office under **Catalog → Categories**.

### 5. Build TypeScript

```bash
npm run build
```

Or use `ts-node` directly (no build step needed for development):

```bash
npm run dev -- sync --dry-run
```

---

## Example commands

### Dry-run full sync (safe — no upload)

```bash
npm run sync:dry
# or after building:
node dist/index.js sync --dry-run
```

Generates CSV files in `/output/` and prints a preview. Nothing is sent to Mirakl.

### Full sync with upload

```bash
npm run sync:upload
# or:
node dist/index.js sync
```

Exports CSVs, uploads them to Mirakl, polls for completion, and saves error reports if any.

### Incremental sync (only changed products)

```bash
npm run sync:incremental
# or:
node dist/index.js sync --incremental
```

Only fetches Shopify products updated since the last successful run (tracked in `/state/last_run.json`).

### Stock-only sync (quantities + prices)

```bash
npm run sync:stock
# or:
node dist/index.js sync --stock-only
```

Uploads an offers file with only price/quantity columns — fastest update, no catalog changes.

### Stock-only + incremental

```bash
node dist/index.js sync --stock-only --incremental
```

### Combine flags

```bash
node dist/index.js sync --incremental --dry-run
```

---

## Architecture

```
shopify-mirakl-connector/
├── src/
│   ├── index.ts               CLI entry point (Commander)
│   ├── config.ts              Env var loading with validation
│   ├── logger.ts              Winston logger (console + rotating file)
│   ├── types.ts               Shared TypeScript interfaces
│   ├── shopifyClient.ts       Admin GraphQL client with cursor pagination
│   ├── miraklClient.ts        OF01/PA01 upload, polling, error reports
│   ├── mappers/
│   │   ├── fieldResolver.ts   Descriptor-based field resolution engine
│   │   ├── productMapper.ts   Shopify product → Mirakl product rows
│   │   └── offerMapper.ts     Shopify variant → Mirakl offer rows
│   ├── exporters/
│   │   └── csvExporter.ts     Safe CSV writer (no sci notation, BOM, CRLF)
│   ├── templates/
│   │   └── templateReader.ts  Excel/CSV template parser
│   ├── state/
│   │   └── stateManager.ts    last_run.json read/write
│   └── commands/
│       └── sync.ts            Sync orchestration + reconciliation summary
├── templates/                 ← DROP YOUR MIRAKL TEMPLATES HERE
├── output/                    Generated CSV files (timestamped)
├── state/                     Sync state (last_run.json)
├── reports/                   Mirakl error reports + sync logs
├── mapping.yaml               Category + field mapping config
└── .env                       Secrets (never commit this)
```

### Field mapping descriptors (mapping.yaml)

The `productFieldMappings` and `offerFieldMappings` sections control how each template column is populated:

| Descriptor | Description | Example |
|---|---|---|
| `field:product.title` | Read from Shopify product | Title |
| `field:variant.price` | Read from Shopify variant | Price |
| `static:EAN` | Always this literal value | product-id-type |
| `default:currency` | From `defaults` section | GBP |
| `option:color` | Variant option (using aliases) | Red |
| `option:size` | Variant size option | UK 10 |
| `image:0` | Product image URL (0-based) | Main image |
| `image:1` | Additional image | Extra image |
| `mapped:product.productType` | Category mapping lookup | FA_DRESSES |
| `tag:color` | Tag with prefix `color:red` | red |

---

## Idempotency

Mirakl uses `SellerProductId` + `SellerArticleId` (or `sku`) as the unique offer key. Re-uploading the same data with `update-delete: U` is a safe upsert — it will not create duplicate listings.

The connector maps:
- **SellerProductId** = Shopify `Product.numericId` (parent style, same for all variants)
- **SellerArticleId** = Shopify `ProductVariant.numericId` (unique per variant)
- For single-variant products, both IDs are the product ID

---

## Server deployment

The connector is a standalone Node.js CLI that can run anywhere:

### Option A — Cron job on a Linux server

```bash
# Install
git clone ... && cd shopify-mirakl-connector
npm ci && npm run build

# Add to crontab — incremental sync every 4 hours, stock-only every hour
0 */4 * * *  cd /opt/mirakl-sync && node dist/index.js sync --incremental
0 * * * *    cd /opt/mirakl-sync && node dist/index.js sync --stock-only --incremental
```

### Option B — Railway / Render / Fly.io

1. Push the repo to GitHub (make sure `.env` is in `.gitignore`)
2. Set environment variables in the platform's dashboard
3. Use a **Cron Job** service type with command: `node dist/index.js sync --incremental`

### Option C — GitHub Actions scheduled workflow

```yaml
# .github/workflows/sync.yml
name: Mirakl Sync
on:
  schedule:
    - cron: '0 */4 * * *'   # every 4 hours

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci && npm run build
      - run: node dist/index.js sync --incremental
        env:
          SHOPIFY_STORE_DOMAIN: ${{ secrets.SHOPIFY_STORE_DOMAIN }}
          SHOPIFY_ADMIN_ACCESS_TOKEN: ${{ secrets.SHOPIFY_ADMIN_ACCESS_TOKEN }}
          MIRAKL_BASE_URL: ${{ secrets.MIRAKL_BASE_URL }}
          MIRAKL_API_KEY: ${{ secrets.MIRAKL_API_KEY }}
```

> **Note on state persistence:** For incremental sync across scheduled runs, the `/state/last_run.json` file must persist between executions. On Railway/Fly.io, mount a persistent volume to the `state/` directory. On GitHub Actions, use `actions/cache` or store the state in a small database/KV store.

---

## Troubleshooting

### "Missing required environment variable"
Ensure `.env` is present in the project root and all required variables are set (no blank values).

### "No Mirakl template files found"
Download the templates from your Mirakl back office (see Setup → Step 3). File names must contain `product`, `offer`, or `import`.

### "Could not find header row in Excel template"
Open the template in Excel and check which row contains the column headers. Mirakl sometimes adds title rows above. The parser checks the first 5 rows.

### Mirakl returns HTTP 401
Your API key is wrong or expired. Regenerate it from _My Account → API Key_ in the back office.

### Mirakl returns HTTP 403
You may need to include `MIRAKL_SHOP_ID` if your API key has access to multiple shops.

### Import fails with "Unknown attribute code"
The column header in your template doesn't match what Mirakl expects. Re-download a fresh template — templates are category-specific and can change when the operator updates the schema.

### Price appearing as scientific notation in Mirakl
This shouldn't happen with this connector (all prices are formatted as fixed decimals), but if you see it, check that `variant.price` is a plain decimal string in Shopify. Very long prices (unlikely) would trigger quoting in the CSV.

### EANs appearing as `1.234E+13` in Excel
The CSV files include a UTF-8 BOM and write EANs as plain strings. If Excel still misinterprets them, open the CSV via _Data → From Text/CSV_ in Excel and set the EAN column type to "Text" during import.

### Large number of "skipped (no SKU)" warnings
Shopify variants without SKUs cannot be reliably identified in Mirakl. Add SKUs to your products in Shopify Admin, or ensure variants at least have a barcode.

---

## Environment variable reference

| Variable | Required | Description |
|---|---|---|
| `SHOPIFY_STORE_DOMAIN` | Yes | Your `.myshopify.com` domain |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Yes | Admin API token with `read_products`, `read_inventory` |
| `SHOPIFY_API_VERSION` | No | API version, default `2024-01` |
| `MIRAKL_BASE_URL` | Yes | Operator URL, e.g. `https://debenhams.mirakl.net` |
| `MIRAKL_API_KEY` | Yes | Seller API key |
| `MIRAKL_SHOP_ID` | No | Required only if key covers multiple shops |
| `LOG_LEVEL` | No | `debug`, `info` (default), `warn`, `error` |
