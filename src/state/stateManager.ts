import * as fs from 'fs';
import * as path from 'path';
import { SyncState } from '../types';
import { logger } from '../logger';

const STATE_FILE = 'last_run.json';

export class StateManager {
  private filePath: string;

  constructor(stateDir: string) {
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    this.filePath = path.join(stateDir, STATE_FILE);
  }

  read(): SyncState {
    if (!fs.existsSync(this.filePath)) {
      return { lastSuccessfulSync: null, lastRunAt: null };
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(raw) as SyncState;
    } catch (err) {
      logger.warn('Could not read state file – starting fresh', { error: String(err) });
      return { lastSuccessfulSync: null, lastRunAt: null };
    }
  }

  write(state: SyncState): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
      logger.error('Failed to write state file', { path: this.filePath, error: String(err) });
      throw err;
    }
  }

  markRunStarted(): void {
    const current = this.read();
    this.write({ ...current, lastRunAt: new Date().toISOString() });
  }

  markSuccess(): void {
    const now = new Date().toISOString();
    this.write({ lastSuccessfulSync: now, lastRunAt: now });
    logger.info('State updated – next incremental sync will start from', { since: now });
  }
}
