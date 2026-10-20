/**
 * Daňový doklad k objednávce e-shopu — stav úhrady a data, která na něm musí
 * být. Čisté funkce bez databáze, ať se pravidla dají otestovat.
 *
 * ## Datum na dokladu není „dnes“
 *
 * Faktura k objednávce vzniká až přepnutím na „Vyřízena“, často dny po
 * platbě. Daňový doklad přitom musí uvádět den uskutečnění plnění nebo den
 * přijetí úplaty, liší-li se ode dne vystavení (§ 29 odst. 1 písm. h ZDPH).
 * Dřív dostala karta zaplacená 1. 9. na fakturu „zaplaceno 7. 9.“.
 *
 * ## Dobírka zaplacená není
 *
 * Zákazník platí až při převzetí a peníze posílá Zásilkovna. Faktura vedená
 * jako zaplacená by u nevyzvednuté zásilky zůstala „zaplacená“ bez peněz
 * a PDF s razítkem ZAPLACENO by totéž tvrdilo zákazníkovi.
 *
 * ## Pražský den
 *
 * Kontejner může běžet v UTC, takže `toISOString()` dává ve 0:30 pražského
 * času ještě včerejšek. Okamžiky (`paid_at`, `warehouse_sent_at`) se proto
 * převádějí na pražský den, sloupce DATE se čtou tak, jak jsou — viz
 * src/prazsky-cas.js.
 */

import { jenDatum, prazskeDatum, pridejDny } from './prazsky-cas.js';

/**
 * Do kolika dnů ode dne, kdy vznikla povinnost přiznat daň (přijetí úplaty,
 * u dobírky plnění), musí vzniknout daňový doklad (§ 28 odst. 8 ZDPH).
 */
export const LHUTA_DOKLADU_DNY = 15;

/**
 * Upozorňuje se na objednávky, u kterých lhůta běží tolik dní nebo déle.
 * Zbývajících pět dní stačí na vyřízení i přes víkend.
 */
export const UPOZORNIT_PO_DNECH = 10;

/** Způsoby platby, jak je ukládá Toneráček (PAYMENT_LABELS v routes/toneracek.js). */
const ZNAME_PLATBY = ['Platba kartou', 'Bankovní převod', 'Dobírka'];

/**
 * Stavy, ve kterých je objednávka placená kartou zaplacená: „Zaplaceno“
 * zapisuje e-shop po potvrzení platby, „Vyřízena“ obsluha až po něm. Sdílí to
 * vystavení faktury i hlídání lhůty (a SQL v checkUninvoicedPaidOrders()).
 */
export const STAVY_ZAPLACENE_KARTY = ['Zaplaceno', 'Vyřízena'];

/**
 * Pražský den platby kartou („YYYY-MM-DD“), nebo null, když ho nejde určit.
 *
 * Primárně `paid_at`, který e-shop zapisuje od migrace 039. Objednávky
 * zaplacené dřív ho nemají; u nich se bere pražský den založení objednávky
 * (`created_at`) — karta se platí rovnou v pokladně, takže je to tentýž den,
 * nanejvýš o pár minut později (výjimkou je platba těsně před půlnocí nebo
 * opakovaná platba po neúspěšném pokusu). Jen u zaplacené objednávky
 * (STAVY_ZAPLACENE_KARTY): u nezaplacené by den založení nic neznamenal.
 * Do databáze se nic nedopisuje — den se dopočítá při vystavení a DUZP jde
 * v úpravě faktury opravit.
 */
export function denPlatbyKartou(objednavka) {
  const zPlatby = prazskeDatum(objednavka?.paid_at);
  if (zPlatby) return zPlatby;
  if (!STAVY_ZAPLACENE_KARTY.includes(objednavka?.status)) return null;
  return prazskeDatum(objednavka.created_at);
}

// ── Vystavení faktury ─────────────────────────────────────────

/**
 * Stav, den úhrady a DUZP vydané faktury k objednávce:
 * `{ status, paidDate, taxableDate }`, data jako „YYYY-MM-DD“.
 *
 * Karta — den přijetí úplaty z denPlatbyKartou(): pražský den `paid_at`,
 * který zapsal e-shop při potvrzení platby, u zaplacené objednávky z doby
 * před migrací 039 pražský den jejího založení. Když nejde ani jedno
 * (objednávka nebyla vedená jako zaplacená), zbývá den vystavení jako dřív.
 * DUZP jde po vystavení opravit v úpravě faktury.
 *
 * Převod — peníze přišly na zálohovou fakturu, rozhoduje její `paid_date`.
 * Bez zaplacené zálohovky převodovou fakturu volající vůbec nevystaví.
 *
 * Dobírka — nic ještě nepřišlo. Faktura je 'Nezaplacena' (stav 'Vystavena'
 * STATUSES_ISSUED nezná, faktura by vypadla z filtrů i z hlídání splatnosti)
 * a plnění se uskutečnilo odesláním, tedy v den vystavení.
 *
 * Cokoli jiného (obecné API posílá způsob platby volným textem) zůstává při
 * dosavadním chování: zaplaceno dnes.
 */
export function uhradaFakturyObjednavky(order, { fromProforma = null, now = new Date() } = {}) {
  const dnes = prazskeDatum(now);

  switch (order?.payment_method) {
    case 'Platba kartou': {
      const den = denPlatbyKartou(order) ?? dnes;
      return { status: 'Zaplacena', paidDate: den, taxableDate: den };
    }
    case 'Bankovní převod': {
      const den = jenDatum(fromProforma?.paid_date) ?? dnes;
      return { status: 'Zaplacena', paidDate: den, taxableDate: den };
    }
    case 'Dobírka':
      return { status: 'Nezaplacena', paidDate: null, taxableDate: dnes };
    default:
      return { status: 'Zaplacena', paidDate: dnes, taxableDate: dnes };
  }
}

/**
 * Hodnota pro `shop_orders.paid_at` při změně stavu platby.
 *
 * Zapisuje se jen první potvrzení. Stripe webhook chodí opakovaně (retry,
 * ruční „resend“ z dashboardu) a e-shop pokaždé pošle „Zaplaceno“ znovu —
 * přepsaný okamžik by posunul den přijetí úplaty, který jde na daňový doklad.
 */
export function okamzikPlatbySql(sql, status) {
  return status === 'Zaplaceno' ? sql`COALESCE(paid_at, NOW())` : sql`paid_at`;
}

/**
 * Den úhrady zadaný při ruční změně stavu na „Zaplacena“ („YYYY-MM-DD“).
 *
 * Je to den, kdy peníze přišly, ne den kliknutí: zálohovka označená ručně
 * dva dny po platbě by jinak posunula DUZP vystavené faktury
 * (uhradaFakturyObjednavky()) i hlídání lhůty, klidně do jiného měsíce DPH.
 * Formulář ho předvyplňuje; když nepřijde nebo nedává smysl, bere se pražský
 * dnešek — ne CURRENT_DATE databáze, který v UTC kontejneru po půlnoci
 * pražského času ukazuje ještě včerejšek.
 */
export function denUhradyZFormulare(vstup, now = new Date()) {
  return jenDatum(vstup) ?? prazskeDatum(now);
}

// ── PDF a e-mail ──────────────────────────────────────────────

/**
 * Co doklad říká o úhradě: razítko, platební instrukce s QR kódem, forma
 * platby a DUZP. Jedno rozhodnutí pro šablonu PDF i pro e-mail, ať si
 * nemůžou odporovat.
 *
 * Dobírka se pozná jen podle objednávky — faktura způsob platby nenese,
 * proto ho volající předává v `paymentMethod`.
 */
export function zobrazeniUhrady({ invoice, paid = false, paymentMethod = '' } = {}) {
  const zaplaceno = Boolean(paid) || invoice?.status === 'Zaplacena';
  const dobirka = !zaplaceno && invoice?.type !== 'proforma' && paymentMethod === 'Dobírka';

  return {
    zaplaceno,
    dobirka,
    // Číslo účtu a QR na dokladu, který se převodem neplatí, svádí k platbě navíc.
    instrukce: !zaplaceno && !dobirka,
    formaPlatby: ZNAME_PLATBY.includes(paymentMethod) ? paymentMethod : 'Bankovní převod',
    // Zálohová faktura daňovým dokladem není — datum plnění by na ní mátlo.
    duzp: invoice?.type === 'issued'
      ? (jenDatum(invoice.taxable_date) ?? jenDatum(invoice.issue_date))
      : null,
  };
}

// ── Hlídání lhůty ─────────────────────────────────────────────

/**
 * Den, od kterého běží lhůta pro daňový doklad („YYYY-MM-DD“), nebo null,
 * když neběží nebo ho Seil nezná. `objednavka` nese `payment_method`,
 * `status`, `paid_at`, `created_at`, `warehouse_sent_at` a `uhrazeno` (den
 * úhrady zálohové faktury).
 *
 * Karta a převod podle téhož dne, který uhradaFakturyObjednavky() dá na
 * fakturu jako den přijetí úplaty: karta denPlatbyKartou() (`paid_at`,
 * u zaplacené objednávky bez něj den založení), převod den úhrady zálohovky.
 * Dobírka zaplacená není, ale plnění proběhlo odesláním: ranní expedice ji
 * posílá do skladu sama, kdežto fakturu vystaví až ruční „Vyřízena“ —
 * rozhoduje proto pražský den `warehouse_sent_at`.
 */
export function denVznikuPovinnosti(objednavka) {
  switch (objednavka?.payment_method) {
    case 'Platba kartou':   return denPlatbyKartou(objednavka);
    case 'Bankovní převod': return jenDatum(objednavka.uhrazeno);
    case 'Dobírka':         return prazskeDatum(objednavka.warehouse_sent_at);
    default:                return prazskeDatum(objednavka.paid_at) ?? jenDatum(objednavka.uhrazeno);
  }
}

/**
 * Lhůta běžící od tohoto dne nebo dřívějšího běží UPOZORNIT_PO_DNECH dní
 * a víc. Platba 1. 9. → upozornění od 11. 9., lhůta končí 16. 9.
 */
export function hraniceUpozorneni(dnes) {
  return pridejDny(dnes, -UPOZORNIT_PO_DNECH);
}

/**
 * Objednávky bez faktury, na které se má dnes upozornit, nejstarší první:
 * `{ id, order_number, den, dobirka }`. `radky` jsou kandidáti z databáze
 * (viz checkUninvoicedPaidOrders() v src/healthcheck-worker.js), `dnes`
 * pražské datum.
 */
export function objednavkyKUpozorneni(radky, dnes) {
  const hranice = hraniceUpozorneni(dnes);
  const poradi = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  return radky
    .map((r) => ({
      id: r.id,
      order_number: String(r.order_number ?? ''),
      den: denVznikuPovinnosti(r),
      dobirka: r.payment_method === 'Dobírka',
    }))
    .filter((o) => o.den && o.den <= hranice)
    .sort((a, b) => poradi(a.den, b.den) || poradi(a.order_number, b.order_number));
}

function kratkeDatum(datum) {
  const [, mesic, den] = datum.split('-');
  return `${Number(den)}. ${Number(mesic)}.`;
}

function objednavkyPlural(n) {
  if (n === 1) return 'objednávka';
  if (n >= 2 && n <= 4) return 'objednávky';
  return 'objednávek';
}

/**
 * Push správcům o objednávkách bez vydané faktury.
 * `objednavky` z objednavkyKUpozorneni(), `dnes` pražské datum.
 */
export function upozorneniNaChybejiciDoklad(objednavky, dnes) {
  const radky = objednavky.map((o) => {
    const lhuta = pridejDny(o.den, LHUTA_DOKLADU_DNY);
    const stav = lhuta < dnes ? `lhůta uplynula ${kratkeDatum(lhuta)}` : `lhůta do ${kratkeDatum(lhuta)}`;
    return `#${o.order_number} ${o.dobirka ? 'dobírka odeslána' : 'zaplaceno'} ${kratkeDatum(o.den)}, ${stav}`;
  });
  const pocet = objednavky.length;

  return {
    title: `${pocet} ${objednavkyPlural(pocet)} bez faktury`,
    body: radky.slice(0, 5).join('; ') + (pocet > 5 ? ` a dalších ${pocet - 5}` : ''),
    url: pocet === 1 ? `/ucetnictvi/objednavky/${objednavky[0].id}` : '/ucetnictvi/objednavky',
  };
}
