// Background worker: pinguje URL z tabulky healthchecks a ukládá výsledky.
// Spouštěn intervalem v server.js po startu.

import { getDb } from './db.js';
import { sendPushToAll } from './push.js';
import { prazskyCas } from './prazsky-cas.js';
import { STAVY_ZAPLACENE_KARTY, objednavkyKUpozorneni, upozorneniNaChybejiciDoklad } from './danovy-doklad.js';

const sql = getDb();

// Odstraní markdown formátování (**, emoji odrážky) pro čistý text v push notifikaci
function toPlainText(message) {
  return message.replace(/\*\*/g, '').replace(/^[🔴⚠️📋]\s*/m, '').trim();
}

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

async function dispatchAlert(eventType, eventKey, message, opts = {}) {
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
      } else if (ch.type === 'push') {
        await sendPushToAll({
          title: opts.title || `[one.seil.space] ${eventType}`,
          body: toPlainText(message),
          url: opts.url || '/nastaveni/healthchecky',
        }, eventType);
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
        await dispatchAlert('app_down', check.id, msg, {
          title: `🔴 ${check.name} je nedostupný`,
          url: check.shop_id ? `/nastaveni/eshopy/${check.shop_id}` : '/nastaveni/healthchecky',
        });
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
      else if (rule.type === 'push') await sendPushToAll({ title: `⚠️ VPS ${label} ${val}${unit}`, body: toPlainText(msg), url: '/nastaveni/healthchecky' }, rule.event_type);
      await logNotification(rule.event_type, 'vps', rule.channel_id, msg);
    } catch (e) {
      console.error('[NOTIFY VPS] Error', e.message);
    }
  }
}

// ── Kontrola faktur po splatnosti ─────────────────────────────
//
// Tři kroky: přeřadit prošlé faktury do stavu "Po splatnosti", připravit
// upomínky podle nastavených prahů a jednou denně o tom dát vědět.
// Upomínky se odsud nikdy neodesílají — jen se zakládají ve stavu 'ceka'.

const DEFAULT_REMINDER_LEVELS = [{ level: 1, days: 3 }, { level: 2, days: 14 }, { level: 3, days: 30 }];

/** Faktury, kterým prošla splatnost, přepne na "Po splatnosti". */
export async function markOverdueInvoices() {
  const updated = await sql`
    UPDATE accounting_invoices
    SET status = 'Po splatnosti', modified_at = NOW()
    WHERE type IN ('issued', 'proforma')
      AND status = 'Nezaplacena'
      AND due_date IS NOT NULL
      AND due_date < CURRENT_DATE
    RETURNING id, number
  `;
  return updated.length;
}

/** Založí chybějící upomínky pro faktury po splatnosti. */
export async function prepareReminders() {
  const [company] = await sql`SELECT reminder_levels FROM company_settings LIMIT 1`;
  const levels = Array.isArray(company?.reminder_levels) && company.reminder_levels.length
    ? company.reminder_levels
    : DEFAULT_REMINDER_LEVELS;

  // Faktury k dobírce do fronty nepatří. Zákazník platí dopravci při převzetí
  // a peníze posílá Zásilkovna souhrnně — „po splatnosti“ tu znamená, že
  // dobírku ještě nikdo nespároval, ne že zákazník dluží. Upomínka by chtěla
  // zaplatit podruhé, a u nevyzvednuté zásilky za zboží, které nedostal.
  // Souhrn po splatnosti pro správce níž je ukazuje dál.
  const overdue = await sql`
    SELECT i.id, i.due_date, (CURRENT_DATE - i.due_date)::int AS days_overdue
    FROM accounting_invoices i
    WHERE i.type = 'issued' AND i.status = 'Po splatnosti' AND i.due_date IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM shop_orders o
        WHERE o.id = i.order_id AND o.payment_method = 'Dobírka'
      )
  `;

  let created = 0;
  for (const inv of overdue) {
    // Jen nejvyšší dosažený stupeň — ať klientovi nechodí tři upomínky naráz
    const reached = levels
      .filter(l => inv.days_overdue >= Number(l.days))
      .sort((a, b) => Number(b.level) - Number(a.level))[0];
    if (!reached) continue;

    const [row] = await sql`
      INSERT INTO invoice_reminders (invoice_id, level, days_overdue, status)
      VALUES (${inv.id}, ${Number(reached.level)}, ${inv.days_overdue}, 'ceka')
      ON CONFLICT (invoice_id, level) DO NOTHING
      RETURNING id
    `;
    if (row) created++;
  }
  return created;
}

export async function checkOverdueInvoices() {
  await markOverdueInvoices();
  await prepareReminders();

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
  const [{ waiting }] = await sql`
    SELECT COUNT(*)::int AS waiting FROM invoice_reminders WHERE status = 'ceka'
  `;
  const reminderLine = waiting ? `\n\n✉️ ${waiting} upomínek čeká na odeslání.` : '';

  const msg = `📋 **${overdue.length} faktur po splatnosti**:\n${list}${overdue.length > 5 ? `\n…a dalších ${overdue.length - 5}` : ''}${reminderLine}`;

  await dispatchAlert('invoice_overdue', 'daily', msg, {
    title: `📋 ${overdue.length} faktur po splatnosti`,
    url: waiting ? '/ucetnictvi/upominky' : '/ucetnictvi/vydane-faktury',
  });
}

// ── Lhůta pro daňový doklad ───────────────────────────────────
//
// Faktura k objednávce vzniká jen ručním přepnutím na „Vyřízena“. Zaplacená
// objednávka, kterou nikdo nevyřídí, tak zůstane bez daňového dokladu, ačkoli
// povinnost přiznat daň vznikla dnem přijetí úplaty a doklad se má vystavit
// do 15 dnů (§ 28 odst. 8 ZDPH). Totéž dobírka: ranní expedice ji pošle do
// skladu sama, zásilka se doručí, a když ji nikdo nevyřídí, doklad nevznikne
// nikdy. Upozorní se, když lhůta běží deset dní a víc — ať zbude pět dní.
//
// Jednou za pražský den a až ráno: klíčem je datum, ne 23h cooldown jako
// u splatnosti, který čas odeslání každý den posune o hodinu a časem ho
// dostane do noci. Jen push správcům — zákazník ani sklad s tím nemají co
// dělat, takže žádný e-mail.

const HODINA_UPOZORNENI_NA_LHUTU = 8;

export async function checkUninvoicedPaidOrders() {
  const { datum: dnes, hodina } = prazskyCas();
  if (hodina < HODINA_UPOZORNENI_NA_LHUTU) return;

  const [uz] = await sql`
    SELECT 1 FROM notification_log
    WHERE event_type = 'faktura_lhuta' AND event_key = ${dnes}
    LIMIT 1
  `;
  if (uz) return;

  // Kandidáti: bez vydané faktury a s něčím, od čeho lhůta běží — platbou
  // kartou (`paid_at`, u zaplacené karty bez něj založením objednávky),
  // zaplacenou zálohovkou nebo odesláním do skladu (dobírka). Který den
  // rozhoduje, určuje podle způsobu platby denVznikuPovinnosti()
  // v src/danovy-doklad.js — tytéž dny, jaké jdou na fakturu, a testované.
  //
  // Karta bez `paid_at` (zaplacená před migrací 039) jen mimo objednávky
  // přenesené z Airtable: ty mají za `id` id záznamu Airtable („rec…“, viz
  // migrace v routes/toneracek.js), pocházejí z doby před spuštěním e-shopu
  // a faktury k nim v Seilu nejsou ani nebudou. Náhradní den založení by je
  // jinak všechny vytáhl do upozornění. Ostatní cesty (paid_at, zálohovka,
  // expedice) historie z Airtable nemá, takže stačí podmínka tady.
  //
  // Zálohovky přes GROUP BY, ne korelovaným poddotazem: dokud není co hlásit,
  // dotaz se opakuje každých pět minut a `accounting_invoices.order_id` nemá index.
  const kandidati = await sql`
    WITH zalohy AS (
      SELECT order_id, MIN(paid_date) AS uhrazeno
      FROM accounting_invoices
      WHERE type = 'proforma' AND status = 'Zaplacena'
      GROUP BY order_id
    )
    SELECT o.id, o.order_number, o.payment_method, o.status, o.paid_at, o.created_at,
           o.warehouse_sent_at, z.uhrazeno
    FROM shop_orders o
    LEFT JOIN zalohy z ON z.order_id = o.id
    WHERE o.status <> 'Stornována'
      AND (
           o.paid_at IS NOT NULL
        OR z.uhrazeno IS NOT NULL
        OR o.warehouse_sent_at IS NOT NULL
        OR (o.payment_method = 'Platba kartou'
            AND o.status IN ${sql(STAVY_ZAPLACENE_KARTY)}
            AND o.id NOT LIKE 'rec%')
      )
      AND NOT EXISTS (
        SELECT 1 FROM accounting_invoices i WHERE i.order_id = o.id AND i.type = 'issued'
      )
  `;
  const objednavky = objednavkyKUpozorneni(kandidati, dnes);
  if (!objednavky.length) return;

  const { title, body, url } = upozorneniNaChybejiciDoklad(objednavky, dnes);

  // Zápis před odesláním, stejně jako u zadržené expedice: bez VAPID klíčů
  // nebo registrovaného zařízení by se push jinak zkoušel každých pět minut.
  await sql`
    INSERT INTO notification_log (event_type, event_key, message)
    VALUES ('faktura_lhuta', ${dnes}, ${`${title}: ${body}`})
  `;

  const { odeslano, duvod } = await sendPushToAll({ title, body, url }, 'faktura_lhuta');
  if (!odeslano) console.warn('[NOTIFY] Upozornění na chybějící fakturu neodešlo:', duvod);
}
