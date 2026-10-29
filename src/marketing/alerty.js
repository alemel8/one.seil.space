/**
 * Upozornění sekce Marketing: selhání nočního stahování a PNO nad prahem
 * e-shopu. Jedou stejnou cestou jako výpadky a faktury po splatnosti —
 * pravidla v Nastavení → Healthchecky (`notification_rules`, event_type
 * `marketing_sync_failed` / `marketing_pno_high`) přes dispatchAlert
 * z healthcheck-worker.js; bez pravidla aspoň push všem registrovaným
 * zařízením (sendPushToAll), ať se o chybě někdo dozví.
 *
 * Dedupe přes `notification_log`: řádek se zapíše PŘED odesláním (důvod v
 * healthcheck-worker.js checkUninvoicedPaidOrders — bez VAPID klíčů by se
 * push jinak zkoušel každý tik). Selhání jednoho zdroje se hlásí jednou za
 * den běhu, PNO jednou za pražský den a e-shop.
 */

import { dispatchAlert } from '../healthcheck-worker.js';
import { sendPushToAll } from '../push.js';

export const UDALOST_SYNC = 'marketing_sync_failed';
export const UDALOST_PNO = 'marketing_pno_high';

const kc = (v) => Number(v || 0).toLocaleString('cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' Kč';

async function uzHlaseno(sql, eventType, eventKey) {
  const [row] = await sql`
    SELECT 1 FROM notification_log WHERE event_type = ${eventType} AND event_key = ${eventKey} LIMIT 1`;
  return Boolean(row);
}

async function posli(sql, log, { eventType, eventKey, title, message, url }) {
  await sql`INSERT INTO notification_log (event_type, event_key, message) VALUES (${eventType}, ${eventKey}, ${message})`;
  let kanaly = 0;
  try {
    kanaly = (await dispatchAlert(eventType, eventKey, message, { title, url })) ?? 0;
  } catch (err) {
    log?.error?.({ err, eventType }, 'Marketing: odeslání upozornění přes pravidla selhalo');
  }
  if (!kanaly) {
    const { odeslano, duvod } = await sendPushToAll({ title, body: message, url }, eventType);
    if (!odeslano) log?.warn?.({ eventType, duvod }, 'Marketing: upozornění nikam neodešlo');
  }
}

/** Selhání stažení zdroje — jednou za zdroj a den běhu. */
export async function oznamSelhaniSyncu(sql, log, { zdroj, beh, shopName, shopSlug }) {
  const eventKey = `${zdroj.id}:${beh.run_date instanceof Date ? beh.run_date.toISOString().slice(0, 10) : String(beh.run_date).slice(0, 10)}`;
  if (await uzHlaseno(sql, UDALOST_SYNC, eventKey)) return false;
  const message = `Marketing: ${zdroj.platform} (${shopName}) se nepodařilo stáhnout${beh.permanent ? ' — trvalá chyba, čeká na opravu v nastavení' : ` (pokus ${beh.attempt})`}: ${String(beh.error || '').slice(0, 300)}`;
  await posli(sql, log, {
    eventType: UDALOST_SYNC, eventKey, message,
    title: `Marketing: stažení ${zdroj.platform} selhalo`,
    url: `/marketing/sync${shopSlug && shopSlug !== 'toneracek' ? `?eshop=${encodeURIComponent(shopSlug)}` : ''}`,
  });
  return true;
}

/** PNO měsíce nad prahem e-shopu — jednou za pražský den. */
export async function oznamPno(sql, log, { shop, datum, pno, prah, naklady, trzby, mesicPopis }) {
  const eventKey = `${shop.id}:${datum}`;
  if (await uzHlaseno(sql, UDALOST_PNO, eventKey)) return false;
  const message = `PNO ${shop.name} ${Number(pno).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} % (práh ${Number(prah).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} %): náklady ${kc(naklady)} / tržby ${kc(trzby)} bez DPH za ${mesicPopis}`;
  await posli(sql, log, {
    eventType: UDALOST_PNO, eventKey, message,
    title: `Marketing: PNO ${shop.name} nad prahem`,
    url: `/marketing${shop.slug && shop.slug !== 'toneracek' ? `?eshop=${encodeURIComponent(shop.slug)}` : ''}`,
  });
  return true;
}
