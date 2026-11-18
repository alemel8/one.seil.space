/**
 * Sledování zásilek odeslaných do skladu.
 *
 * Objednávka, která odešla do skladu, čeká, až ji sklad zabalí a předá
 * Zásilkovně. Plánovač se každých pár minut ptá Zásilkovny na stav zásilek
 * (packetStatus) a jakmile hlásí, že balík převzala (`jePrevzataDopravcem`
 * v src/packeta.js), objednávku vyřídí – stejně, jako kdyby ji obsluha
 * přepnula na „Vyřízena“: vznikne faktura a zákazník dostane e-mail s ní
 * a se sledovacím číslem (src/vyrizeni-objednavky.js).
 *
 * ## Koho se ptá
 *
 * Jen objednávek, které skladu odešly (`warehouse_sent_at`) v posledních
 * SLEDOVAT_DNI dnech, ještě nejsou vyřízené ani stornované, mají číslo
 * zásilky a nemají vydanou fakturu. Faktura u nevyřízené objednávky znamená,
 * že na ni sáhl člověk (záchranné „Vystavit fakturu“, vrácení stavu
 * z „Vyřízena“), a automat mu do toho nemluví. Stejně tak objednávka, kterou
 * automat už jednou vyřídil (`auto_fulfilled_at`) a člověk ji vrátil zpátky.
 *
 * Jednu zásilku se ptá nejvýš jednou za INTERVAL_KONTROLY_MIN minut. Sklad
 * předává balíky jednou dvakrát denně, takže zákazník dostane e-mail do půl
 * hodiny od převzetí a Zásilkovna nedostává zbytečné dotazy.
 *
 * Zásilka, která za SLEDOVAT_DNI dní nikdy převzatá nebyla, už sledovaná
 * není. Bez faktury ji pak najde upozornění na lhůtu pro daňový doklad
 * (checkUninvoicedPaidOrders v src/healthcheck-worker.js) dřív, než lhůta
 * uplyne.
 *
 * ## Co když se něco nepovede
 *
 * Chyba Zásilkovny u jedné zásilky: zapíše se čas dotazu a další se zkusí za
 * INTERVAL_KONTROLY_MIN. Nevznikne faktura nebo neodejde e-mail: důvod
 * zůstane u objednávky (`auto_fulfill_error`, vidět na detailu) a správci
 * dostanou push – nejvýš jednou za sedm dní na objednávku. Nevzniklá faktura
 * se zkouší znovu při další kontrole, neodeslaný e-mail ne (objednávka už je
 * vyřízená a e-mail jde poslat z detailu faktury).
 */

import { getDb } from './db.js';
import { fetchPacketStatus, jePrevzataDopravcem, STAVY_KONECNE } from './packeta.js';
import { normalizujCisloZasilky } from './expedice.js';
import { vyridObjednavku } from './vyrizeni-objednavky.js';
import { sendPushToAll } from './push.js';

/** Jak často se nejvýš ptát na jednu zásilku. */
export const INTERVAL_KONTROLY_MIN = 30;

/** Jak dlouho po odeslání do skladu zásilku sledovat. */
export const SLEDOVAT_DNI = 14;

/** Kolik zásilek nejvýš za jeden tik – Zásilkovna odpovídá i po desítkách sekund. */
const DAVKA = 40;

/** Jak často tik běží. */
const TIK_MS = 5 * 60_000;

export async function najdiSledovaneZasilky(sql, { now = new Date(), davka = DAVKA } = {}) {
  return sql`
    SELECT o.id, o.order_number, o.shop_id, o.tracking_number, o.packet_status
    FROM shop_orders o
    WHERE o.warehouse_sent_at IS NOT NULL
      AND o.warehouse_sent_at > ${now}::timestamptz - make_interval(days => ${SLEDOVAT_DNI})
      AND o.status NOT IN ('Vyřízena', 'Stornována')
      AND o.tracking_number <> ''
      AND o.auto_fulfilled_at IS NULL
      AND o.packet_status <> ALL(${STAVY_KONECNE}::text[])
      AND (o.packet_checked_at IS NULL
           OR o.packet_checked_at <= ${now}::timestamptz - make_interval(mins => ${INTERVAL_KONTROLY_MIN}))
      AND NOT EXISTS (
        SELECT 1 FROM accounting_invoices i WHERE i.order_id = o.id AND i.type = 'issued'
      )
    ORDER BY o.packet_checked_at NULLS FIRST, o.warehouse_sent_at
    LIMIT ${davka}`;
}

/**
 * Push o objednávkách, které automat nevyřídil celé. Dedupe na sedm dní
 * podle objednávky, jinak by nevznikající faktura bzučela každou půlhodinu.
 */
async function oznamProblemy(sql, problemy, log, notify) {
  const nove = [];
  for (const { zasilka, chyba } of problemy) {
    const [uz] = await sql`
      SELECT 1 FROM notification_log
      WHERE event_type = 'vyrizeni_po_prevzeti' AND event_key = ${String(zasilka.id)}
        AND sent_at > NOW() - INTERVAL '7 days'
      LIMIT 1`;
    if (uz) continue;
    nove.push({ zasilka, chyba });
    await sql`
      INSERT INTO notification_log (event_type, event_key, message)
      VALUES ('vyrizeni_po_prevzeti', ${String(zasilka.id)}, ${`#${zasilka.order_number}: ${chyba}`.slice(0, 500)})`;
  }
  if (!nove.length) return;

  const prvni = nove[0];
  await notify({
    title: 'Zásilkovna převzala balík, vyřízení se nepovedlo celé',
    body: nove.slice(0, 5).map(p => `#${p.zasilka.order_number} – ${p.chyba}`).join('; ')
      + (nove.length > 5 ? ` a dalších ${nove.length - 5}` : ''),
    url: nove.length === 1 ? `/ucetnictvi/objednavky/${encodeURIComponent(prvni.zasilka.id)}` : '/ucetnictvi/objednavky',
  }, 'expedice').catch(err => log?.warn?.({ err }, 'Push o nevyřízených objednávkách neodešel'));
}

let bezi = false;

/**
 * Jeden průchod. Závislosti jdou podstrčit kvůli testům; v provozu se volá
 * jen s `log`.
 */
export async function tikSledovaniZasilek(log, {
  sql = getDb(), now = new Date(), nactiStav = fetchPacketStatus,
  vyrid = vyridObjednavku, notify = sendPushToAll,
} = {}) {
  if (bezi) return { preskoceno: 'bezi' };
  // Bez hesla se Zásilkovny zeptat nejde – stejně jako štítky v expedici.
  if (nactiStav === fetchPacketStatus && !process.env.PACKETA_API_PASSWORD) return { preskoceno: 'bez-hesla' };

  bezi = true;
  try {
    const zasilky = await najdiSledovaneZasilky(sql, { now });
    const vyrizene = [];
    const problemy = [];

    for (const zasilka of zasilky) {
      // Čas dotazu se zapisuje i po chybě, ať se rozbitá zásilka nezkouší každý tik.
      // modified_at schválně ne: dotaz na stav není změna objednávky.
      const norm = normalizujCisloZasilky(zasilka.tracking_number);
      if (!norm) {
        await sql`UPDATE shop_orders SET packet_checked_at = ${now} WHERE id = ${zasilka.id}`;
        continue;
      }

      let stav;
      try {
        stav = await nactiStav(norm);
      } catch (err) {
        log?.warn?.({ err, order: zasilka.order_number, zasilka: norm }, 'Stav zásilky se nepodařilo zjistit');
        await sql`UPDATE shop_orders SET packet_checked_at = ${now} WHERE id = ${zasilka.id}`;
        continue;
      }

      await sql`
        UPDATE shop_orders
        SET packet_status = ${stav.codeText}, packet_status_text = ${String(stav.statusText ?? '').slice(0, 500)},
            packet_status_at = ${stav.dateTime ?? null}, packet_checked_at = ${now}
        WHERE id = ${zasilka.id}`;

      if (!jePrevzataDopravcem(stav)) continue;

      let vysledek;
      try {
        vysledek = await vyrid(sql, log, zasilka.id, { automat: true });
      } catch (err) {
        log?.error?.({ err, order: zasilka.order_number }, 'Vyřízení objednávky po převzetí zásilky spadlo');
        vysledek = { vysledek: 'chyba', chyba: err.message };
        await sql`
          UPDATE shop_orders SET auto_fulfill_error = ${`Vyřízení spadlo: ${err.message}`.slice(0, 500)}
          WHERE id = ${zasilka.id}`;
      }

      if (vysledek.vysledek === 'vyrizena') {
        vyrizene.push(zasilka.order_number);
        log?.info?.({ order: zasilka.order_number, zasilka: norm, stav: stav.codeText, email: vysledek.email },
          'Objednávka vyřízena po převzetí zásilky Zásilkovnou');
      }
      if (vysledek.chyba) problemy.push({ zasilka, chyba: vysledek.chyba });
    }

    await oznamProblemy(sql, problemy, log, notify);
    return { zkontrolovano: zasilky.length, vyrizene, problemy: problemy.length };
  } finally {
    bezi = false;
  }
}

export function startSledovaniZasilekScheduler(log) {
  const tik = () => tikSledovaniZasilek(log).catch(err => log?.error?.({ err }, 'sledování zásilek tick error'));
  setTimeout(tik, 90_000);
  setInterval(tik, TIK_MS);
}
