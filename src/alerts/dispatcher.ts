import { query } from '../db/pool';
import { logger } from '../logger';

export interface AlertConfig {
  webhookUrl?: string;
  emailTo?: string;
  resendApiKey?: string;
  resendFrom?: string;
}

async function sendEmail(config: AlertConfig, subject: string, html: string, text: string): Promise<void> {
  if (!config.resendApiKey || !config.emailTo) return;

  const from = config.resendFrom ?? 'Mirakl Connector <onboarding@resend.dev>';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [config.emailTo],
      subject,
      html,
      text,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend API ${response.status}: ${body}`);
  }
}

export async function dispatchAlerts(config: AlertConfig): Promise<void> {
  const hasWebhook = !!config.webhookUrl;
  const hasEmail = !!config.resendApiKey && !!config.emailTo;

  if (!hasWebhook && !hasEmail) return;

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
      const plainText = `[${alert.severity.toUpperCase()}] ${alert.category}: ${alert.message}`;

      // Send to webhook (Slack/Discord)
      if (hasWebhook) {
        const text = `${emoji} **[${alert.severity.toUpperCase()}]** ${alert.category}\n${alert.message}`;
        const response = await fetch(config.webhookUrl!, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text }),
        });
        if (!response.ok) {
          logger.warn('Webhook dispatch failed', { alertId: alert.id, status: response.status });
        }
      }

      // Send email via Resend
      if (hasEmail) {
        const subject = `${alert.severity === 'critical' ? 'CRITICAL' : alert.severity === 'warning' ? 'Warning' : 'Info'}: Mirakl Connector — ${alert.category}`;
        const metadata = alert.metadata ? JSON.stringify(alert.metadata, null, 2) : '';
        const html = `
          <div style="font-family: sans-serif; max-width: 600px;">
            <h2 style="color: ${alert.severity === 'critical' ? '#dc2626' : alert.severity === 'warning' ? '#d97706' : '#2563eb'}">
              ${emoji} ${alert.severity.toUpperCase()}: ${alert.category}
            </h2>
            <p>${alert.message}</p>
            ${metadata ? `<pre style="background: #f3f4f6; padding: 12px; border-radius: 4px; font-size: 12px; overflow-x: auto;">${metadata}</pre>` : ''}
            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;">
            <p style="color: #6b7280; font-size: 12px;">
              Louche × Debenhams Connector | ${new Date(alert.created_at).toISOString()}
            </p>
          </div>`;

        await sendEmail(config, subject, html, `${plainText}\n\n${metadata}`);
      }

      await query(`UPDATE alerts SET dispatched = TRUE WHERE id = $1`, [alert.id]);
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      logger.error('Failed to dispatch alert', { alertId: alert.id, error: String(err), consecutiveFailures });
      if (consecutiveFailures >= 3) {
        logger.warn('Alert dispatch stopped after 3 consecutive failures, will retry next cycle');
        break;
      }
      continue;
    }
  }
}
