import webpush from 'web-push';
import { getDb } from './db.js';

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL   = process.env.VAPID_EMAIL || 'mailto:info@seil.cz';

let configured = false;

function ensureConfigured() {
  if (configured) return;
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.warn('[push] VAPID klíče nejsou nastaveny — push notifikace vypnuty');
    return;
  }
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
  configured = true;
}

export function getVapidPublicKey() {
  return VAPID_PUBLIC || null;
}

/**
 * Notifikace všem, kdo mají daný typ zapnutý. `type` ('new_order' | jiný
 * řetězec) se filtruje podle `user_notification_prefs`; kdo tam řádek nemá,
 * bere se jako zapnutý.
 *
 * Vrací souhrn `{ odeslano, selhalo, duvod }`, aby šlo zjistit, proč
 * notifikace nepřišla. Dřív to zjistit nešlo: funkce mlčky skončila bez VAPID
 * klíčů i bez jediné subscription a obě volání u nové objednávky měla
 * `.catch(() => {})`, takže „push nikomu nechodí“, „nikdo nemá registrované
 * zařízení“ a „Apple to odmítl“ vypadaly v logu stejně — totiž nijak.
 *
 * `duvod` je prázdný, když aspoň jedna notifikace odešla.
 */
export async function sendPushToAll(payload, type = 'new_order') {
  ensureConfigured();
  if (!configured) return { odeslano: 0, selhalo: 0, duvod: 'nejsou nastavené VAPID klíče' };

  const sql = getDb();

  // Načti subscriptions uživatelů, kteří mají daný typ notifikace povolený.
  // Uživatelé bez záznamu v prefs mají výchozí hodnotu TRUE.
  const subs = await sql`
    SELECT ps.endpoint, ps.p256dh, ps.auth
    FROM push_subscriptions ps
    LEFT JOIN user_notification_prefs p ON p.user_id = ps.user_id
    WHERE
      CASE ${type}
        WHEN 'new_order' THEN COALESCE(p.notify_new_order, TRUE)
        ELSE TRUE
      END
  `;

  if (!subs.length) {
    return { odeslano: 0, selhalo: 0, duvod: `žádné registrované zařízení s povoleným typem „${type}“` };
  }

  return odesli(sql, subs, payload);
}

/**
 * Notifikace jen na zařízení jednoho uživatele. Pohání zkušební odeslání
 * v nastavení — bez něj je jediný spouštěč push notifikace skutečná
 * objednávka, takže se registrace zařízení nedá ověřit jinak než čekáním.
 */
export async function sendPushToUser(userId, payload) {
  ensureConfigured();
  if (!configured) return { odeslano: 0, selhalo: 0, duvod: 'nejsou nastavené VAPID klíče' };

  const sql = getDb();
  const subs = await sql`
    SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ${userId}
  `;

  if (!subs.length) {
    return { odeslano: 0, selhalo: 0, duvod: 'tenhle účet nemá registrované žádné zařízení' };
  }

  return odesli(sql, subs, payload);
}

async function odesli(sql, subs, payload) {
  const message = JSON.stringify(payload);
  let odeslano = 0;
  let selhalo = 0;
  let duvod = '';

  await Promise.allSettled(
    subs.map(async sub => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          message
        );
        odeslano++;
      } catch (err) {
        selhalo++;
        // 410/404 je odhlášené zařízení — úklid, ne chyba k řešení. Cokoli
        // jiného (401 za špatné VAPID klíče, 413 za velký payload) si zaslouží
        // dostat se ven, jinak se hledá po hmatu.
        if (err.statusCode === 410 || err.statusCode === 404) {
          await sql`DELETE FROM push_subscriptions WHERE endpoint = ${sub.endpoint}`.catch(() => {});
        } else {
          duvod = `${err.statusCode ?? '?'} ${err.body || err.message}`.trim().slice(0, 200);
        }
      }
    })
  );

  if (!odeslano && !duvod) duvod = 'všechna registrovaná zařízení byla mezitím odhlášena';
  return { odeslano, selhalo, duvod: odeslano ? '' : duvod };
}
