import { loadConfig } from '../../config';
import { query } from '../../db/pool';
import { sendEmail } from '../../alerts/dispatcher';
import { logger } from '../../logger';

/**
 * Weekly operator triage email — runs Mon 08:00 UTC.
 *
 * Summarises open catalog orphans (pending_catalog rows where resolved_at IS
 * NULL) so the operator has a single point of visibility for the data-quality
 * backlog. Skipped jobs themselves are low-severity / no-email, so without
 * this digest the operator has no regular nudge to clean them up.
 *
 * Sections:
 *   1. By error_code × age bucket (0-1d, 1-3d, 3-7d, 7-30d, 30d+)
 *   2. Top 20 by attempts (most noisy SKUs)
 *
 * Empty backlog → no email (nothing to triage).
 */

const AGE_BUCKETS = ['0-1d', '1-3d', '3-7d', '7-30d', '30d+'] as const;

type GroupedRow = { code: string; age_bucket: string; count: string } & Record<string, unknown>;
type TopOrphan = {
  sku: string;
  code: string;
  attempts: number;
  first_seen_at: Date;
  last_seen_at: Date;
  mirakl_error_msg: string | null;
} & Record<string, unknown>;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function handleWeeklyTriage(_payload: Record<string, unknown>): Promise<void> {
  const config = loadConfig();
  const emailTo = config.hardening.alertEmailTo;
  const resendApiKey = config.hardening.resendApiKey;
  const resendFrom = config.hardening.resendFrom;

  if (!emailTo || !resendApiKey) {
    logger.warn('[weekly_triage] Skipping — email not configured', { hasTo: !!emailTo, hasKey: !!resendApiKey });
    return;
  }

  // Total open orphans — short-circuit the email if the backlog is empty.
  const totalRes = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM pending_catalog WHERE resolved_at IS NULL`
  );
  const totalN = parseInt(totalRes.rows[0]?.n ?? '0', 10);

  if (totalN === 0) {
    logger.info('[weekly_triage] No open orphans — no email sent');
    return;
  }

  // Breakdown by error_code × age bucket
  const grouped = await query<GroupedRow>(`
    SELECT error_code AS code,
           CASE
             WHEN first_seen_at >= NOW() - INTERVAL '1 day'   THEN '0-1d'
             WHEN first_seen_at >= NOW() - INTERVAL '3 days'  THEN '1-3d'
             WHEN first_seen_at >= NOW() - INTERVAL '7 days'  THEN '3-7d'
             WHEN first_seen_at >= NOW() - INTERVAL '30 days' THEN '7-30d'
             ELSE '30d+'
           END AS age_bucket,
           COUNT(*) AS count
      FROM pending_catalog
     WHERE resolved_at IS NULL
     GROUP BY code, age_bucket
     ORDER BY code, age_bucket
  `);

  // Top 20 by attempts
  const top = await query<TopOrphan>(`
    SELECT sku, error_code AS code, attempts, first_seen_at, last_seen_at, mirakl_error_msg
      FROM pending_catalog
     WHERE resolved_at IS NULL
     ORDER BY attempts DESC, last_seen_at DESC
     LIMIT 20
  `);

  // Pivot grouped rows into {code: {bucket: count}} for the table
  const codes: string[] = [];
  const groupedMap: Record<string, Record<string, number>> = {};
  for (const row of grouped.rows) {
    if (!groupedMap[row.code]) {
      groupedMap[row.code] = {};
      codes.push(row.code);
    }
    groupedMap[row.code][row.age_bucket] = parseInt(row.count, 10);
  }

  const th = 'style="border:1px solid #ccc;padding:6px 10px;background:#f3f4f6;text-align:left;"';
  const thRight = 'style="border:1px solid #ccc;padding:6px 10px;background:#f3f4f6;text-align:right;"';
  const td = 'style="border:1px solid #ccc;padding:6px 10px;"';
  const tdRight = 'style="border:1px solid #ccc;padding:6px 10px;text-align:right;"';

  const groupedTable = `
    <table style="border-collapse:collapse;margin-bottom:20px;font-size:14px;">
      <tr>
        <th ${th}>Error code</th>
        ${AGE_BUCKETS.map(b => `<th ${thRight}>${b}</th>`).join('')}
        <th ${thRight}>Total</th>
      </tr>
      ${codes.map(code => {
        const row = AGE_BUCKETS.map(b => groupedMap[code]?.[b] ?? 0);
        const rowTotal = row.reduce((a, b) => a + b, 0);
        return `<tr>
          <td ${td}><code>${escapeHtml(code)}</code></td>
          ${row.map(n => `<td ${tdRight}>${n}</td>`).join('')}
          <td ${tdRight}><strong>${rowTotal}</strong></td>
        </tr>`;
      }).join('')}
    </table>
  `;

  const topTable = top.rows.length === 0 ? '' : `
    <table style="border-collapse:collapse;margin-bottom:20px;font-size:14px;">
      <tr>
        <th ${th}>SKU</th>
        <th ${th}>Code</th>
        <th ${thRight}>Attempts</th>
        <th ${th}>First seen</th>
        <th ${th}>Last seen</th>
        <th ${th}>Mirakl message</th>
      </tr>
      ${top.rows.map(r => `<tr>
        <td ${td}><code>${escapeHtml(r.sku)}</code></td>
        <td ${td}><code>${escapeHtml(r.code)}</code></td>
        <td ${tdRight}>${r.attempts}</td>
        <td ${td}>${r.first_seen_at.toISOString().slice(0, 10)}</td>
        <td ${td}>${r.last_seen_at.toISOString().slice(0, 10)}</td>
        <td ${td}>${escapeHtml((r.mirakl_error_msg ?? '').slice(0, 120))}</td>
      </tr>`).join('')}
    </table>
  `;

  const html = `
    <div style="font-family:sans-serif;max-width:780px;color:#111;">
      <h2 style="color:#2563eb;">Mirakl connector — weekly catalogue orphan triage</h2>
      <p><strong>${totalN}</strong> open orphan SKU${totalN === 1 ? '' : 's'} as of ${new Date().toISOString()}.</p>
      <p>These SKUs have triggered Shopify inventory webhooks but Mirakl rejected them permanently (most commonly "state of the product is unknown"). The resurrection poller will re-enqueue any that become active on Mirakl. Anything open &gt;7 days is likely a true data-quality issue: variant SKU renamed, product deleted on Mirakl, or product never accepted via PA01.</p>
      <h3 style="margin-top:24px;">By error code &amp; age</h3>
      ${groupedTable}
      <h3 style="margin-top:24px;">Top 20 by attempts</h3>
      ${topTable}
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;">
      <p style="color:#6b7280;font-size:12px;">Louche × Debenhams Connector · weekly_triage handler</p>
    </div>
  `;

  const text = `Mirakl connector — weekly catalogue orphan triage\n\n${totalN} open orphan SKUs.\n\nBy code & age:\n${codes.map(c => {
    const totals = AGE_BUCKETS.reduce((s, b) => s + (groupedMap[c]?.[b] ?? 0), 0);
    return `  ${c}: ${totals}`;
  }).join('\n')}\n\nSee HTML body for per-bucket and top-20 breakdown.`;

  await sendEmail(
    { resendApiKey, emailTo, resendFrom },
    `Mirakl connector — ${totalN} open orphans (weekly triage)`,
    html,
    text,
  );

  // Record in sync_state for audit trail
  await query(
    `INSERT INTO sync_state (key, value) VALUES ('last_weekly_triage', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify({
      at: new Date().toISOString(),
      totalOpen: totalN,
      codes: codes.length,
      topListed: top.rowCount,
    })]
  );

  logger.info('[weekly_triage] Email sent', { totalOpen: totalN, codes: codes.length, topListed: top.rowCount });
}
