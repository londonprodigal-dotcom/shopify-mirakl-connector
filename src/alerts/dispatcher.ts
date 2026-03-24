import * as nodemailer from 'nodemailer';
import { query } from '../db/pool';
import { logger } from '../logger';

interface AlertConfig {
  webhookUrl?: string;
  emailTo?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom?: string;
}

let mailer: nodemailer.Transporter | null = null;

function getMailer(config: AlertConfig): nodemailer.Transporter | null {
  if (mailer) return mailer;
  if (!config.smtpHost || !config.smtpUser || !config.smtpPass) return null;

  mailer = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort ?? 587,
    secure: config.smtpPort === 465,
    auth: { user: config.smtpUser, pass: config.smtpPass },
  });
  return mailer;
}

export async function dispatchAlerts(config: AlertConfig): Promise<void> {
  const hasWebhook = !!config.webhookUrl;
  const hasEmail = !!config.emailTo && !!config.smtpHost;

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

      // Send email
      if (hasEmail) {
        const transport = getMailer(config);
        if (transport) {
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

          await transport.sendMail({
            from: config.smtpFrom ?? config.smtpUser,
            to: config.emailTo,
            subject,
            text: `${plainText}\n\n${metadata}`,
            html,
          });
        }
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
