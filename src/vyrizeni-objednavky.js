/**
 * Vyřízení objednávky e-shopu: vydaná faktura, e-mail s ní zákazníkovi
 * a stav „Vyřízena“.
 *
 * Dva volající:
 * - obsluha přepne stav na detailu objednávky (routes/toneracek.js),
 * - sledování zásilek (src/sledovani-zasilek.js), když Zásilkovna hlásí, že
 *   balík převzala.
 *
 * ## Zámek
 *
 * Oba můžou přijít naráz: obsluha klikne ve chvíli, kdy tik zrovna vyřizuje
 * tutéž objednávku. Na vydanou fakturu k objednávce není unikátní index,
 * takže bez zámku by vznikly dvě faktury a zákazník by dostal dva e-maily.
 * Proto `pg_advisory_xact_lock` na id objednávky a kontrola existující
 * faktury až pod ním. Zámek drží transakce na vlastním spojení, práce jde
 * přes běžný pool – po pádu procesu se spojení zavře a zámek pustí.
 *
 * ## Co se liší mezi obsluhou a automatem
 *
 * Obsluha dostane přesně to, co dřív: stav se přepne, i když faktura nebo
 * e-mail selže (chyba jde do logu). Automat je opatrnější, protože ho nikdo
 * nevidí: když faktura nevznikne, stav nechá, zapíše důvod k objednávce
 * a zkusí to při další kontrole. Když neodejde jen e-mail, objednávka se
 * vyřídí (faktura existuje) a důvod zůstane na detailu.
 */

import { brandForShopId } from './brand.js';
import { pozadejEshopOPodaniBaliku } from './expedice.js';
import { zobrazeniUhrady } from './danovy-doklad.js';

/** První klíč dvouklíčového advisory locku – jmenný prostor „vyřízení objednávky“. */
const ZAMEK_VYRIZENI = 52_001;

export const VYRIZENA = 'Vyřízena';

/**
 * Výchozí doručení faktury: PDF a e-mail „vyřízena a předána dopravci“.
 * Text e-mailu je tentýž, jaký dřív posílalo přepnutí stavu v routách.
 */
export async function odesliFakturuZakaznikovi(sql, order, invoice) {
  const { calcVatSummary } = await import('./routes/invoices.js');
  const { renderInvoicePdf } = await import('./pdf.js');
  const { sendInvoiceEmail } = await import('./email.js');

  const items = await sql`SELECT * FROM accounting_invoice_items WHERE invoice_id = ${invoice.id}`;
  const [company] = await sql`SELECT * FROM company_settings LIMIT 1`;
  const issuer = company || {};

  // Táž chyba jako u zálohovky: bez klíče `total` tiskla šablona
  // v rekapitulaci DPH "NaN Kč".
  const vatSummary = calcVatSummary(items);

  // Tracking je k dispozici: u karty ho zapsal Stripe webhook,
  // u dobírky založení objednávky a u převodu ho dožádal
  // pozadejEshopOPodaniBaliku() ve vyridObjednavku(). Jde ven jedním
  // e-mailem spolu s fakturou.
  // Bez brandu by tenhle e-mail – nejdůležitější zpráva celé
  // objednávky – odešel jako SEIL s.r.o. <noreply@seil.cz>, tedy
  // od firmy, o které zákazník e-shopu nikdy neslyšel.
  const brand = await brandForShopId(order.shop_id);
  // Karta a převod jsou v tuhle chvíli zaplacené a doklad nevyzývá
  // k další platbě. Dobírka ne: zákazník platí až při převzetí,
  // takže razítko ZAPLACENO by u nevyzvednuté zásilky lhalo – PDF
  // místo něj i místo čísla účtu napíše, že se platí dobírkou.
  const uhrada = zobrazeniUhrady({ invoice, paymentMethod: order.payment_method });
  const pdfBuffer = await renderInvoicePdf({
    invoice, items, issuer, vatSummary, brand,
    paid: uhrada.zaplaceno, paymentMethod: order.payment_method,
  });
  // Vyřízená objednávka je vždycky zároveň předaná dopravci, takže
  // je to jedna zpráva, ne dvě varianty. Sledovací číslo tu bývá
  // (e-shop ho pošle hned po podání zásilky), ale když chybí,
  // zbytek e-mailu dává smysl i bez něj.
  await sendInvoiceEmail({
    invoice, issuer, brand, email: order.email, pdfBuffer,
    paid: uhrada.zaplaceno, paymentMethod: order.payment_method,
    trackingNumber: order.tracking_number || undefined,
    subject: `Objednávka #${order.order_number} vyřízena a předána dopravci`,
    intro: `Vaše objednávka č. <strong>${order.order_number}</strong> byla vyřízena a předána dopravci.<br>V příloze naleznete fakturu${order.tracking_number ? ', níže sledovací číslo zásilky' : ''}.${uhrada.dobirka ? '<br>Částku zaplatíte při převzetí zásilky.' : ''}`,
  });
}

/**
 * Vyřídí objednávku. Vrací, co se stalo:
 *
 * - `{ vysledek: 'vyrizena', faktura, novaFaktura, email, chyba }` – stav je
 *   „Vyřízena“; `email` je 'odeslan' | 'chyba' | 'bez-adresy' | 'neposilal'
 *   (faktura existovala už dřív, e-mail tedy odešel tehdy),
 * - `{ vysledek: 'proforma-nezaplacena' }` – převod bez zaplacené zálohovky
 *   (u automatu i s `chyba`, zapsanou k objednávce),
 * - `{ vysledek: 'chyba', chyba }` – jen automat: faktura nevznikla, stav beze změny,
 * - `{ vysledek: 'preskoceno', stav }` – jen automat: mezitím ji vyřídil
 *   nebo stornoval člověk,
 * - `{ vysledek: 'nenalezena' }`.
 */
export async function vyridObjednavku(sql, log, orderId, { automat = false, odesliFakturu = odesliFakturuZakaznikovi } = {}) {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${ZAMEK_VYRIZENI}, hashtext(${String(orderId)}))`;
    return provedVyrizeni(sql, log, orderId, { automat, odesliFakturu });
  });
}

async function provedVyrizeni(sql, log, orderId, { automat, odesliFakturu }) {
  // Čte se až pod zámkem: stav i tracking mohl mezitím změnit druhý volající.
  const [order] = await sql`SELECT * FROM shop_orders WHERE id = ${orderId}`;
  if (!order) return { vysledek: 'nenalezena' };
  if (automat && (order.status === VYRIZENA || order.status === 'Stornována')) {
    return { vysledek: 'preskoceno', stav: order.status };
  }

  const [existujici] = await sql`
    SELECT * FROM accounting_invoices WHERE order_id = ${order.id} AND type = 'issued' LIMIT 1`;

  let faktura = existujici ?? null;
  let email = 'neposilal';
  let chyba = '';

  if (!faktura) {
    const isTransfer = order.payment_method === 'Bankovní převod';
    const [proforma] = await sql`
      SELECT * FROM accounting_invoices WHERE order_id = ${order.id} AND type = 'proforma' LIMIT 1`;
    if (isTransfer && (!proforma || proforma.status !== 'Zaplacena')) {
      // Do skladu nezaplacený převod nejde (podminkaKExpedici), takže
      // u automatu je to anomálie pro člověka – ať je vidět na detailu.
      if (!automat) return { vysledek: 'proforma-nezaplacena' };
      chyba = 'Zálohová faktura není zaplacená, objednávka zůstala nevyřízená';
      await sql`UPDATE shop_orders SET auto_fulfill_error = ${chyba} WHERE id = ${order.id}`;
      return { vysledek: 'proforma-nezaplacena', chyba };
    }

    /*
     * Teprve tady je jisté, že jsou peníze na účtu – u převodu to hlídá
     * kontrola zálohovky o pár řádků výš, u karty Stripe webhook, který
     * balík podal už dřív. Proto se zásilka zakládá až v tuhle chvíli.
     *
     * Musí to být PŘED sestavením e-mailu s fakturou: ten nese sledovací
     * číslo, a to do téhle chvíle u převodu neexistovalo. Automat sem
     * s prázdným trackingem nikdy nepřijde – sleduje jen zásilky.
     */
    if (!order.tracking_number) {
      await pozadejEshopOPodaniBaliku(log, await brandForShopId(order.shop_id), order);
      const [cerstva] = await sql`SELECT tracking_number FROM shop_orders WHERE id = ${order.id}`;
      if (cerstva?.tracking_number) order.tracking_number = cerstva.tracking_number;
    }

    try {
      const { generateInvoiceForOrder } = await import('./routes/invoices.js');
      faktura = await generateInvoiceForOrder(sql, order, { fromProforma: isTransfer ? proforma : null });
      log?.info?.({ invoiceId: faktura.id, number: faktura.number, automat }, 'Auto-faktura vygenerována');
    } catch (err) {
      log?.error?.({ err, order: order.order_number, automat }, 'Fakturu k vyřízení objednávky se nepodařilo vystavit');
      chyba = `Faktura nevznikla: ${err.message}`;
      if (automat) {
        await sql`
          UPDATE shop_orders SET auto_fulfill_error = ${chyba.slice(0, 500)}, modified_at = NOW()
          WHERE id = ${order.id}`;
        return { vysledek: 'chyba', chyba };
      }
    }

    if (faktura && !order.email) email = 'bez-adresy';
    if (faktura && order.email) {
      try {
        await odesliFakturu(sql, order, faktura);
        email = 'odeslan';
        log?.info?.({ email: order.email, tracking: order.tracking_number || null, automat }, 'Email s fakturou odeslán');
      } catch (err) {
        email = 'chyba';
        chyba = `E-mail s fakturou zákazníkovi neodešel: ${err.message}`;
        log?.error?.({ err, order: order.order_number, automat }, 'Chyba při odeslání e-mailu s fakturou při vyřízení objednávky');
      }
    }
  }

  // Ruční vyřízení starou chybu automatu maže – obsluha ji tím vyřešila.
  await sql`
    UPDATE shop_orders
    SET status = ${VYRIZENA},
        auto_fulfilled_at = ${automat ? sql`NOW()` : sql`auto_fulfilled_at`},
        auto_fulfill_error = ${automat ? chyba.slice(0, 500) : ''},
        modified_at = NOW()
    WHERE id = ${order.id}`;

  return { vysledek: 'vyrizena', faktura, novaFaktura: !existujici && Boolean(faktura), email, chyba };
}
