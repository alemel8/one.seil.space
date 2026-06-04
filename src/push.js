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

// type: 'new_order' | string — filtruje dle user_notification_prefs
export async function sendPushToAll(payload, type = 'new_order') {
  ensureConfigured();
  if (!configured) return;

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

  if (!subs.length) return;

  const message = JSON.stringify(payload);

  await Promise.allSettled(
    subs.map(async sub => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          message
        );
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await sql`DELETE FROM push_subscriptions WHERE endpoint = ${sub.endpoint}`.catch(() => {});
        }
      }
    })
  );
}
