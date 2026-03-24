import { query } from '../db/pool';
import { logger } from '../logger';

export async function dispatchAlerts(webhookUrl: string | undefined): Promise<void> {
  if (!webhookUrl) return;

  const undispatched = await query<{
    id: number; severity: string; category: string; message: string; metadata: unknown; created_at: Date;
  }>(
    `SELECT * FROM alerts WHERE dispatched = FALSE ORDER BY created_at ASC LIMIT 10`
  );

  if (undispatched.rows.length === 0) return;

  let consecutiveFailures = 0;

  for (const alert of undispatched.rows) {
    try {
      const emoji = alert.severity === 'critical' ? '\u{1F534}' : alert.severity === 'warning' ? '\u{1F7E1}' : '\u2139\uFE0F';
      const text = `${emoji} **[${alert.severity.toUpperCase()}]** ${alert.category}\n${alert.message}`;

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      await query(`UPDATE alerts SET dispatched = TRUE WHERE id = $1`, [alert.id]);
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      logger.error('Failed to dispatch alert', { alertId: alert.id, error: String(err), consecutiveFailures });

      // After 3 consecutive failures, stop — webhook is likely down.
      // Undispatched alerts will be retried next dispatcher cycle (30s).
      if (consecutiveFailures >= 3) {
        logger.warn('Alert dispatch stopped after 3 consecutive failures, will retry next cycle');
        break;
      }
      // Single failure: skip this alert and try the next one
      continue;
    }
  }
}
