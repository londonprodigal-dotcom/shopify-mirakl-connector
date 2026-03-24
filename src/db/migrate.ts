import * as fs from 'fs';
import * as path from 'path';
import { getPool, query } from './pool';
import { logger } from '../logger';

export async function runMigrations(): Promise<void> {
  // Ensure sync_state table exists (bootstrap)
  await query(`CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  const applied = await getAppliedMigrations();
  const migrationsDir = resolveMigrationsDir();
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    logger.info(`Running migration: ${file}`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await query(sql);
    await query(
      `INSERT INTO sync_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [`migration:${file}`, JSON.stringify({ applied_at: new Date().toISOString() })]
    );
    logger.info(`Migration applied: ${file}`);
  }

  // Seed from last_run.json if sync_state is empty
  await seedFromFileState();
}

async function getAppliedMigrations(): Promise<Set<string>> {
  try {
    const result = await query<{ key: string }>(`SELECT key FROM sync_state WHERE key LIKE 'migration:%'`);
    return new Set(result.rows.map(r => r.key.replace('migration:', '')));
  } catch { return new Set(); }
}

function resolveMigrationsDir(): string {
  // Try dist/ first (production), fall back to src/ (development)
  const distDir = path.resolve(__dirname, 'migrations');
  if (fs.existsSync(distDir)) return distDir;
  const srcDir = path.resolve(__dirname, '..', '..', 'src', 'db', 'migrations');
  if (fs.existsSync(srcDir)) return srcDir;
  throw new Error('Migrations directory not found');
}

async function seedFromFileState(): Promise<void> {
  const result = await query<{ key: string }>(`SELECT key FROM sync_state WHERE key = 'last_successful_sync'`);
  if (result.rows.length > 0) return; // Already seeded

  const stateFile = path.resolve(__dirname, '..', '..', 'state', 'last_run.json');
  if (!fs.existsSync(stateFile)) return;

  try {
    const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (data.lastSuccessfulSync) {
      await query(
        `INSERT INTO sync_state (key, value) VALUES ('last_successful_sync', $1) ON CONFLICT DO NOTHING`,
        [JSON.stringify({ timestamp: data.lastSuccessfulSync })]
      );
      logger.info('Seeded sync_state from last_run.json', { lastSuccessfulSync: data.lastSuccessfulSync });
    }
  } catch (err) {
    logger.warn('Could not seed from last_run.json', { error: String(err) });
  }
}
