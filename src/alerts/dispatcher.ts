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

  for (const alert of undispatched.rows) {
    try {
      const emoji = alert.severity === 'critical' ? '\u{1F534}' : alert.severity === 'warning' ? '\u{1F7E1}' : '\u2139\uFE0F';
      const text = `${emoji} **[${alert.severity.toUpperCase()}]** ${alert.category}\n${alert.message}`;

      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }), // Discord format
      });

      await query(`UPDATE alerts SET dispatched = TRUE WHERE id = $1`, [alert.id]);
    } catch (err) {
      logger.error('Failed to dispatch alert', { alertId: alert.id, error: String(err) });
      break; // Don't spam on transient failures
    }
  }
}
