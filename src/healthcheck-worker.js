// Background worker: pinguje URL z tabulky healthchecks a ukládá výsledky.
// Spouštěn intervalem v server.js po startu.

import { getDb } from './db.js';

const sql = getDb();

// Vrátí true pokud jsme toto upozornění poslali v posledních `cooldownMs` ms
async function alreadyNotified(eventType, eventKey, cooldownMs = 3_600_000) {
  const [row] = await sql`
    SELECT 1 FROM notification_log
    WHERE event_type = ${eventType} AND event_key = ${String(eventKey)}
      AND sent_at > NOW() - ${`${cooldownMs / 1000} seconds`}::interval
    LIMIT 1
  `;
  return !!row;
}

async function logNotification(eventType, eventKey, channelId, message) {
  await sql`
    INSERT INTO notification_log (event_type, event_key, channel_id, message)
    VALUES (${eventType}, ${String(eventKey)}, ${channelId}, ${message})
  `;
}

async function sendDiscord(webhookUrl, message) {
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: message }),
  });
}

async function sendEmailNotification(toEmail, subject, text) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: 'one.seil.space <noreply@seil.cz>',
      to: [toEmail],
      subject,
      text,
    }),
  });
}

async function dispatchAlert(eventType, eventKey, message) {
  const channels = await sql`
    SELECT c.* FROM notification_rules r
    JOIN notification_channels c ON r.channel_id = c.id
    WHERE r.event_type = ${eventType} AND r.active = TRUE AND c.active = TRUE
  `;
  for (const ch of channels) {
    try {
      if (ch.type === 'discord') {
        await sendDiscord(ch.target, message);
      } else if (ch.type === 'email') {
        await sendEmailNotification(ch.target, `[one.seil.space] ${eventType}`, message);
      }
      await logNotification(eventType, eventKey, ch.id, message);
    } catch (err) {
      console.error('[NOTIFY] Error sending to channel', ch.id, err.message);
    }
  }
}

// ── Ping jednotlivých healthchecků ───────────────────────────
export async function runHealthchecks() {
  const checks = await sql`SELECT * FROM healthchecks WHERE active = TRUE`;
  for (const check of checks) {
    const start = Date.now();
    let ok = false, statusCode = null, error = null;
    try {
      const res = await fetch(check.url, { signal: AbortSignal.timeout(10_000) });
      statusCode = res.status;
      ok = res.ok;
    } catch (e) {
      error = e.message;
    }
    const latency = Date.now() - start;

    await sql`
      INSERT INTO healthcheck_results (check_id, ok, status_code, latency_ms, error)
      VALUES (${check.id}, ${ok}, ${statusCode}, ${latency}, ${error})
    `;

    // Smaž výsledky starší než 7 dní
    await sql`DELETE FROM healthcheck_results WHERE check_id = ${check.id} AND checked_at < NOW() - INTERVAL '7 days'`;

    // Notifikace při výpadku
    if (!ok) {
      const notified = await alreadyNotified('app_down', check.id);
      if (!notified) {
        const msg = `🔴 **${check.name}** je nedostupný!\nURL: ${check.url}\nChyba: ${error || `HTTP ${statusCode}`}`;
        await dispatchAlert('app_down', check.id, msg);
      }
    }
  }
}

// ── Kontrola VPS prahů ────────────────────────────────────────
export async function checkVpsThresholds(latest) {
  if (!latest || latest.error) return;

  const rules = await sql`
    SELECT r.*, c.type, c.target, c.name AS ch_name
    FROM notification_rules r
    JOIN notification_channels c ON r.channel_id = c.id
    WHERE r.event_type IN ('disk_high','ram_high','cpu_high') AND r.active=TRUE AND c.active=TRUE
  `;

  const metrics = {
    disk_high: latest.disk ? Math.round(latest.disk.used_gb / latest.disk.total_gb * 100) : null,
    ram_high:  latest.memory ? Math.round(latest.memory.used_mb / latest.memory.total_mb * 100) : null,
    cpu_high:  latest.cpu?.load_1m ?? null,
  };

  for (const rule of rules) {
    const val = metrics[rule.event_type];
    if (val === null) continue;
    const threshold = Number(rule.threshold || (rule.event_type === 'cpu_high' ? 3 : 85));
    if (val < threshold) continue;

    const notified = await alreadyNotified(rule.event_type, 'vps', 6 * 3_600_000); // 6h cooldown
    if (notified) continue;

    const label = { disk_high: 'Disk', ram_high: 'RAM', cpu_high: 'CPU load' }[rule.event_type];
    const unit  = rule.event_type === 'cpu_high' ? '' : ' %';
    const msg   = `⚠️ VPS **${label}** přesáhl práh: ${val}${unit} (práh ${threshold}${unit})`;

    try {
      if (rule.type === 'discord') await sendDiscord(rule.target, msg);
      else if (rule.type === 'email') await sendEmailNotification(rule.target, `[VPS Alert] ${label} ${val}${unit}`, msg);
      await logNotification(rule.event_type, 'vps', rule.channel_id, msg);
    } catch (e) {
      console.error('[NOTIFY VPS] Error', e.message);
    }
  }
}

// ── Kontrola faktur po splatnosti ─────────────────────────────
export async function checkOverdueInvoices() {
  const overdue = await sql`
    SELECT id, number, client_name, total_amount, currency, due_date
    FROM accounting_invoices
    WHERE type='issued' AND status='Po splatnosti'
    ORDER BY due_date
  `;
  if (overdue.length === 0) return;

  const notified = await alreadyNotified('invoice_overdue', 'daily', 23 * 3_600_000);
  if (notified) return;

  const list = overdue.slice(0, 5).map(i =>
    `• ${i.number} — ${i.client_name} — ${Number(i.total_amount).toLocaleString('cs-CZ')} ${i.currency}`
  ).join('\n');
  const msg = `📋 **${overdue.length} faktur po splatnosti**:\n${list}${overdue.length > 5 ? `\n…a dalších ${overdue.length - 5}` : ''}`;

  await dispatchAlert('invoice_overdue', 'daily', msg);
}
