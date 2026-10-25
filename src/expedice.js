/**
 * Ranní expedice zaplacených objednávek do skladu.
 *
 * Každý všední den po šesté hodině pražského času odejde skladu jeden e-mail
 * se všemi zaplacenými objednávkami, které ještě nedostal, a se štítky
 * Zásilkovny v příloze. Co přijde v pátek po odeslání, jde v pondělí — víkend
 * oknem neprojde.
 *
 * ## Pořadí zápisů se nesmí měnit
 *
 * claim → výběr → balíky → štítky → **razítko** → odeslání → `email_sent_at`
 * → dokončení.
 *
 * Řádek běhu vzniká PŘED prací a razítko na objednávkách PŘED odesláním.
 * Kdyby se to „zjednodušilo“ na „pošli a pak zapiš“, stačil by pád procesu
 * mezi přijetím e-mailu Resendem a commitem (deploy v 06:02, SIGTERM) a sklad
 * by druhý den balil tytéž objednávky podruhé. Když odeslání selže, razítko
 * se zase odvolá — proto `warehouse_sent_by IS NULL`, ať se nesmaže ruční
 * označení obsluhy.
 *
 * ## Pražský čas se počítá, nečte
 *
 * Dockerfile nenastavuje TZ ani neinstaluje tzdata a v Coolify to nikdo
 * negarantuje, takže `new Date().getHours()` může být UTC. Okno i datum běhu
 * proto počítá `prazskyCas()` přes `Intl` (src/prazsky-cas.js).
 *
 * ## Zaplaceno se nepozná z jednoho sloupce
 *
 * Karta: Stripe webhook zapíše `shop_orders.status = 'Zaplaceno'` a e-shop
 * hned podá balík — proto u karty platí i vyplněný tracking (obsluha může
 * stav v administraci přepsat zpátky na „Přijata“). Převod: jediný spolehlivý
 * signál je zálohová faktura ve stavu „Zaplacena“; tracking u převodu nic
 * neznamená, protože e-shop podá balík i u nezaplacené objednávky, když
 * zákazník po neúspěšné kartě přepne na převod. Dobírka se platí při převzetí,
 * balík má od založení.
 */

import { getDb } from './db.js';
import { brandForShopId } from './brand.js';
import { fetchPacketLabelPdf } from './packeta.js';
import { sendExpediceEmail } from './email.js';
import { esc } from './email-templates.js';
import { sendPushToAll } from './push.js';
import { jenDatum, prazskyCas } from './prazsky-cas.js';

// Testy a routy objednávek ho berou odsud, kde byl dřív doma.
export { prazskyCas };

// ── Konstanty ─────────────────────────────────────────────────

/** Hodina pražského času, od které se ráno odesílá. */
export const HODINA_EXPEDICE = 6;

/**
 * Dopočtené řádky, které e-shop ukládá mezi položky objednávky (doprava,
 * dobírka, sleva za registraci). Zrcadlo `ADJUSTMENT_SKUS` v e-shopu —
 * sklad je vychystávat nemá.
 */
export const PSEUDO_SKU = ['SLEVA-REG', 'DOPRAVA', 'DOBIRKA'];

/** Běh visící v „probiha“ déle než tohle spadl i s procesem. */
const ZAMRZLY_BEH_MS = 30 * 60_000;

/** Kolikrát se běh po přechodné chybě zopakuje, než si řekne o obsluhu. */
const MAX_POKUSU = 6;

/** Lineární backoff mezi pokusy: 10, 20, 30… minut. */
const BACKOFF_MS = 10 * 60_000;

/** HTTP stavy e-shopu, které se opakováním nespraví. */
const TRVALE_HTTP = [400, 401, 403, 404, 422];

/**
 * E-shop, který jde v ranní expedici první a jehož odkazy a pushe zůstávají
 * bez označení e-shopu (seznam objednávek ho ukazuje bez ?eshop=).
 */
const VYCHOZI_ESHOP = 'toneracek';

/** Co se stalo, řečí obsluhy. Používá UI i push. */
export const DUVODY_POZASTAVENI = {
  'bez-vydejniho-mista': 'objednávka nemá výdejní místo, balík nelze podat — vyřiďte ji ručně a označte',
  'balik-nepodan': 'e-shop balík nepodal (Zásilkovna nebo e-shop neodpověděl), zkusí se znovu',
  'stitek-nestazen': 'štítek se nepodařilo stáhnout ze Zásilkovny, zkusí se znovu',
  'neplatne-cislo-zasilky': 'číslo zásilky není platné číslo Zásilkovny',
};

const DUVODY_KRATCE = {
  'bez-vydejniho-mista': 'bez výdejního místa',
  'balik-nepodan': 'balík se nepodal',
  'stitek-nestazen': 'štítek se nestáhl',
  'neplatne-cislo-zasilky': 'neplatné číslo zásilky',
};

// ── Čisté funkce (bez databáze, testovatelné) ─────────────────

export function jePseudoPolozka(sku) {
  return PSEUDO_SKU.includes(String(sku ?? '').trim().toUpperCase());
}

/**
 * Multipack se pozná podle SKU: v katalogu mají prefix `MC` (inkousty) nebo
 * `MT` (tonery), běžné zboží `C` nebo `T`. Sloupec `multipack_id` použít nejde
 * — je ve schématu od začátku a nikdy se neplní.
 */
export function jeMultipack(sku) {
  return /^M[A-Z]\d/i.test(String(sku ?? '').trim());
}

/**
 * Číslo zásilky na jeden tvar: bez mezer, velkými písmeny, s vedoucím „Z“.
 *
 * Je to klíč, pod kterým se objednávky slučují do jedné zásilky, i název
 * přílohy. Tvar hodnoty není zaručený — e-shop ukládá čárový kód Zásilkovny
 * doslova a u objednávek přenesených z Airtable je to volný text, co kdo
 * napsal. Co nevypadá jako číslo zásilky, vrací prázdný řetězec; volající
 * takovou objednávku pozastaví, místo aby si o štítek řekl s nesmyslem.
 */
export function normalizujCisloZasilky(raw) {
  const bezMezer = String(raw ?? '').replace(/\s+/g, '').toUpperCase();
  const kandidat = /^[A-Z]/.test(bezMezer) ? bezMezer : `Z${bezMezer}`;
  return /^[A-Z]{1,2}\d{6,}$/.test(kandidat) ? kandidat : '';
}

/** „Z864684“ → „Z 864 684“. Po trojicích zleva, zbytek se přilepí na konec. */
export function formatujCisloZasilky(norm) {
  const hodnota = String(norm ?? '');
  if (!hodnota) return '';
  const prefix = hodnota.match(/^[A-Za-z]+/)?.[0] ?? '';
  const skupiny = hodnota.slice(prefix.length).match(/\d{1,3}/g) ?? [];
  // Osamocená číslice na konci („… 789 0“) se čte hůř než čtyřmístná skupina.
  if (skupiny.length > 1 && skupiny[skupiny.length - 1].length === 1) {
    skupiny[skupiny.length - 2] += skupiny.pop();
  }
  return [prefix, ...skupiny].filter(Boolean).join(' ');
}

/**
 * Jeden řádek vychystávacího seznamu: „11208 - 2x - Canon CRG-737“.
 *
 * Když kód dodavatele chybí (objednávky před nasazením, multipacky), tiskne se
 * místo něj interní SKU a řádek si nese varování — sklad má poznat, že to není
 * kód, podle kterého vychystává.
 */
export function radekPolozky(item) {
  const kodDodavatele = String(item?.supplier_code ?? '').trim();
  const sku = String(item?.sku ?? '').trim();
  const kod = kodDodavatele || sku || '?';
  const pocet = Number(item?.quantity ?? 1) || 1;
  const nazev = String(item?.name ?? '').trim() || 'bez názvu';

  let varovani = null;
  if (!kodDodavatele && jeMultipack(sku)) varovani = 'multipack, chybí kód dodavatele';
  else if (!kodDodavatele) varovani = 'chybí kód dodavatele';
  else if (jeMultipack(sku)) varovani = 'multipack';

  return { kod, pocet, nazev, text: `${kod} - ${pocet}x - ${nazev}`, varovani };
}

/**
 * Objednávky do skupin po zásilkách. Jedna zásilka = jeden nadpis v e-mailu.
 * Objednávky bez použitelného čísla zásilky sem nepatří — volající je
 * pozastaví dřív.
 */
export function seskupPodleZasilek(objednavky, polozkyPodleObjednavky) {
  const skupiny = new Map();

  for (const objednavka of objednavky) {
    const norm = normalizujCisloZasilky(objednavka.tracking_number);
    if (!norm) continue;

    let skupina = skupiny.get(norm);
    if (!skupina) {
      skupina = { norm, zobrazeni: formatujCisloZasilky(norm), orderNumbers: [], radky: [] };
      skupiny.set(norm, skupina);
    }
    skupina.orderNumbers.push(String(objednavka.order_number ?? ''));

    const polozky = polozkyPodleObjednavky?.get?.(objednavka.id) ?? [];
    for (const item of polozky) {
      if (jePseudoPolozka(item.sku)) continue;
      skupina.radky.push(radekPolozky(item));
    }
  }

  return [...skupiny.values()];
}

/**
 * Okno pro odeslání. Bez horní hranice schválně: když server ležel do
 * jedenácti, je lepší poslat v jedenáct než až další den.
 */
export function jeVOkne({ den, hodina }) {
  return den >= 1 && den <= 5 && hodina >= HODINA_EXPEDICE;
}

/**
 * Co dělat s dnešním automatickým během. Čistá rozhodovací matice, aby se
 * obnova po pádu dala otestovat bez databáze.
 */
export function rozhodniBeh({ dnesni, now = new Date(), bezi = false }) {
  if (!dnesni) return { akce: 'zalozit', duvod: 'dnes ještě neběželo' };
  if (dnesni.status === 'odeslano' || dnesni.status === 'prazdno') {
    return { akce: 'nic', duvod: 'dnes už doběhlo' };
  }

  const stari = now.getTime() - new Date(dnesni.started_at).getTime();

  if (dnesni.status === 'probiha') {
    if (bezi) return { akce: 'nic', duvod: 'běh právě probíhá v tomhle procesu' };
    if (stari < ZAMRZLY_BEH_MS) return { akce: 'nic', duvod: 'běh probíhá' };
    // Zamrzlý běh, který stihl odeslat, se jen dopíše — druhý e-mail nikdy.
    if (dnesni.email_sent_at) return { akce: 'dokoncit', duvod: 'e-mail odešel, chybí jen dokončení' };
    return { akce: 'oznacit-chybu', duvod: 'Běh přerušen restartem serveru' };
  }

  if (dnesni.status === 'chyba') {
    const pokus = Number(dnesni.attempt) || 1;
    if (pokus >= MAX_POKUSU) return { akce: 'nic', duvod: 'vyčerpané pokusy, čeká se na obsluhu' };
    if (stari < pokus * BACKOFF_MS) return { akce: 'nic', duvod: 'čeká se na další pokus' };
    return { akce: 'opakovat', duvod: `pokus ${pokus + 1}` };
  }

  return { akce: 'nic', duvod: `neznámý stav ${dnesni.status}` };
}

const CZ_DATUM_CAS = new Intl.DateTimeFormat('cs-CZ', {
  timeZone: 'Europe/Prague', weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

const CZ_DATUM = new Intl.DateTimeFormat('cs-CZ', {
  timeZone: 'Europe/Prague', weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric',
});

export function zasilkyPlural(n) {
  if (n === 1) return 'zásilka';
  if (n >= 2 && n <= 4) return 'zásilky';
  return 'zásilek';
}

/**
 * Tělo e-mailu pro sklad. Nadpisem je číslo zásilky, pod ním řádky položek —
 * přesně v tom tvaru, na který je sklad zvyklý. Pozastavené objednávky se sem
 * nepíšou, to je interní věc administrace.
 */
export function sestavEmail({ shopName, obdobiOd, obdobiDo = new Date(), skupiny }) {
  const pocet = skupiny.length;
  const subject = `Expedice ${shopName}: ${CZ_DATUM.format(obdobiDo)} (${pocet} ${zasilkyPlural(pocet)})`;

  const obdobi = obdobiOd
    ? `za období od <strong>${esc(CZ_DATUM_CAS.format(new Date(obdobiOd)))}</strong> do <strong>${esc(CZ_DATUM_CAS.format(obdobiDo))}</strong>`
    : `k <strong>${esc(CZ_DATUM_CAS.format(obdobiDo))}</strong>`;

  const bloky = skupiny.map((skupina) => {
    const radky = skupina.radky.length
      ? skupina.radky.map(r =>
          `${esc(r.text)}${r.varovani ? ` <span style="color:#b45309">(${esc(r.varovani)})</span>` : ''}`
        ).join('<br>')
      : '<span style="color:#b45309">objednávka bez položek — zkontrolujte ji v administraci</span>';

    const cisla = skupina.orderNumbers.map(n => `#${esc(n)}`).join(', ');

    return `
        <p style="margin:18px 0 4px;font-size:15px;color:#18181b"><strong>${esc(skupina.zobrazeni)}</strong>
          <span style="color:#71717a;font-size:12px">obj. ${cisla}</span></p>
        <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#27272a;line-height:1.7">${radky}</div>`;
  }).join('');

  const html = `
        <p style="font-size:15px;color:#334155;margin:0 0 16px">Dobrý den,</p>
        <p style="font-size:14px;color:#475569;line-height:1.6;margin:0 0 8px">
          posíláme objednávky k expedici ${obdobi}.
          Štítky Zásilkovny jsou v příloze, jeden soubor na zásilku.
        </p>
${bloky}
        <p style="font-size:13px;color:#64748b;margin:24px 0 0">
          Celkem ${pocet} ${zasilkyPlural(pocet)}. Zprávu generuje One SEIL automaticky.
        </p>`;

  return { subject, html };
}

// ── Práce s databází ──────────────────────────────────────────

export class ExpediceBeziError extends Error {
  constructor() {
    super('Expedice pro tenhle e-shop právě běží');
    this.name = 'ExpediceBeziError';
  }
}

/**
 * Podmínka „objednávka patří do skladu“. Jediná definice, kterou sdílí ranní
 * běh i seznam objednávek — kdyby si každý filtroval po svém, ikona
 * v administraci by tvrdila něco jiného než e-mail.
 *
 * Očekává alias `o` (shop_orders) a `p` (poslední zálohová faktura).
 */
export function podminkaKExpedici(sql, shop) {
  // DATE sloupec z pg přijde jako Date; do dotazu patří „YYYY-MM-DD“, ať se nekonvertuje přes pásmo.
  const od = jenDatum(shop.warehouse_dispatch_since) ?? '1970-01-01';
  return sql`
        o.shop_id = ${shop.id}
    AND o.warehouse_sent_at IS NULL
    AND o.created_at >= (${od}::date::timestamp AT TIME ZONE 'Europe/Prague')
    AND o.status NOT IN ('Stornována', 'Čeká na platbu', 'Platba se nezdařila')
    AND (
         (o.payment_method = 'Platba kartou'   AND (o.status IN ('Zaplaceno', 'Vyřízena') OR o.tracking_number <> ''))
      OR (o.payment_method = 'Bankovní převod' AND p.status = 'Zaplacena')
      OR  o.payment_method = 'Dobírka'
    )`;
}

/** Stav pro sloupec „Sklad“ v administraci. Staví na téže podmínce jako e-mail. */
export function skladStavSql(sql, shop) {
  return sql`CASE
      WHEN o.warehouse_sent_at IS NOT NULL THEN 'odeslano'
      WHEN o.warehouse_hold_reason <> '' AND (${podminkaKExpedici(sql, shop)}) THEN 'blokovano'
      WHEN (${podminkaKExpedici(sql, shop)}) THEN 'ceka'
      ELSE 'neplati'
    END`;
}

/** Poddotaz nad shop_orders obohacený o `sklad_stav`. `where` si dodá volající (aliasy `o` a `p`). */
export function objednavkySeStavemSkladu(sql, shop, where) {
  return sql`
    SELECT o.*, ${skladStavSql(sql, shop)} AS sklad_stav
    FROM shop_orders o
    LEFT JOIN LATERAL (
      SELECT status FROM accounting_invoices
      WHERE order_id = o.id AND type = 'proforma'
      ORDER BY (status = 'Zaplacena') DESC, created_at DESC
      LIMIT 1
    ) p ON TRUE
    ${where}`;
}

export async function najdiObjednavkyKExpedici(sql, shop) {
  return sql`
    SELECT * FROM (${
      objednavkySeStavemSkladu(sql, shop, sql`WHERE ${podminkaKExpedici(sql, shop)}`)
    }) x ORDER BY x.created_at`;
}

export async function nactiPolozky(sql, orderIds) {
  const mapa = new Map(orderIds.map(id => [id, []]));
  if (!orderIds.length) return mapa;

  const rows = await sql`
    SELECT order_id, sku, supplier_code, name, quantity
    FROM shop_order_items
    WHERE order_id = ANY(${orderIds}::text[])
    ORDER BY id`;

  for (const row of rows) mapa.get(row.order_id)?.push(row);
  return mapa;
}

/**
 * Požádá e-shop, ať podá zásilku u Zásilkovny.
 *
 * Bydlelo to v routách objednávek, protože jediným volajícím bylo přepnutí na
 * „Vyřízena“. Teď to potřebuje i ranní běh: u převodu vzniká balík až tím
 * přepnutím, takže zaplacená objednávka ráno žádný štítek nemá.
 *
 * Nikdy nevyhazuje — přepnutí stavu ani ranní běh nesmí spadnout kvůli tomu,
 * že Zásilkovna zrovna neodpovídá. Vrací i HTTP stav, aby volající poznal
 * trvalou chybu (chybí výdejní místo) od přechodné (e-shop je dole).
 */
export async function pozadejEshopOPodaniBaliku(log, brand, order) {
  const secret = await webhookSecretEshopu(order.shop_id ?? brand?.id, log, brand);
  if (!secret) {
    const toneracek = brand?.slug === VYCHOZI_ESHOP;
    log?.warn?.({ order: order.order_number, eshop: brand?.slug },
      toneracek
        ? 'SHOP_WEBHOOK_SECRET není nastaveno, balík se nepodal — podej ho ručně'
        : 'E-shop nemá vlastní tajemství pro podání balíku (Nastavení → Eshopy), balík se nepodal — podej ho ručně');
    return {
      ok: false,
      error: toneracek ? 'SHOP_WEBHOOK_SECRET není nastaveno' : 'E-shop nemá tajemství pro podání balíku',
    };
  }
  if (!brand?.url) return { ok: false, error: 'E-shop nemá vyplněnou adresu' };

  try {
    const res = await fetch(`${brand.url}/api/orders/podat-balik`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secret },
      body: JSON.stringify({ orderNumber: order.order_number, email: order.email }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      log?.error?.({ order: order.order_number, status: res.status, data },
        'E-shop odmítl podat balík');
      return { ok: false, httpStatus: res.status, error: data?.error || `HTTP ${res.status}` };
    }

    log?.info?.({ order: order.order_number, tracking: data.tracking, uzPodano: data.uzPodano },
      'Balík podán');
    return { ok: true, httpStatus: res.status, tracking: data.tracking || '', uzPodano: Boolean(data.uzPodano) };
  } catch (err) {
    log?.error?.({ err, order: order.order_number }, 'Podání balíku se nepodařilo vyžádat');
    return { ok: false, error: err.message };
  }
}

/**
 * Tajemství pro volání e-shopu (hlavička x-webhook-secret).
 *
 * Toneráček jede jen na globální SHOP_WEBHOOK_SECRET jako před migrací 040;
 * `shops.webhook_secret` se u něj nečte a administrace mu ho nastavit nedá.
 * Jinak by jedno kliknutí v nastavení podepisovalo jeho balíky tajemstvím,
 * které e-shop Toneráčku nezná: podat-balik by vracel 401 a převody by se
 * vyřizovaly bez zásilky. S předanou značkou (`znacka` z brandForShopId) se
 * Toneráček na databázi vůbec neptá.
 *
 * Ostatní e-shopy mají jen vlastní tajemství. Globální je tajemství Toneráčku
 * — kdo ho zná, nechá u Toneráčku podat balík k jakékoli objednávce, i
 * nezaplacené —, takže se jinému e-shopu nikdy neposílá: bez vlastního
 * tajemství (i když se ho nepodaří načíst) se vrací '' a balík se nepodá
 * (volající to hlásí jako „podej ho ručně“, expedice objednávku zadrží).
 */
export async function webhookSecretEshopu(shopId, log, znacka = null) {
  const globalni = process.env.SHOP_WEBHOOK_SECRET || '';
  if (znacka?.slug === VYCHOZI_ESHOP && Number(znacka.id) === Number(shopId)) return globalni;
  if (!shopId) return '';

  let shop;
  try {
    [shop] = await getDb()`SELECT slug, webhook_secret FROM shops WHERE id = ${shopId}`;
  } catch (err) {
    log?.error?.({ err, shopId }, 'Tajemství e-shopu se nepodařilo načíst, balík se nepodá');
    return '';
  }
  if (!shop) return '';
  if (shop.slug === VYCHOZI_ESHOP) return globalni;
  return shop.webhook_secret || '';
}

/**
 * Zabere řádek běhu. U automatického běhu je `ON CONFLICT DO NOTHING` zámek
 * pro oba částečné indexy naráz: prázdný výsledek znamená „dnes už běželo“
 * nebo „něco právě běží“ a volající nemá co dělat.
 */
export async function zalozBeh(sql, { shop, kind = 'auto', runDate, userId = null }) {
  try {
    if (kind === 'auto') {
      const [row] = await sql`
        INSERT INTO warehouse_dispatches (shop_id, kind, run_date, status, attempt, recipient)
        VALUES (${shop.id}, 'auto', ${runDate}, 'probiha', 1, ${shop.warehouse_email})
        ON CONFLICT DO NOTHING
        RETURNING *`;
      return row ?? null;
    }

    const [row] = await sql`
      INSERT INTO warehouse_dispatches (shop_id, kind, run_date, status, attempt, recipient, started_by)
      VALUES (${shop.id}, 'rucni', ${runDate}, 'probiha', 1, ${shop.warehouse_email}, ${userId})
      RETURNING *`;
    return row;
  } catch (err) {
    if (err.code === '23505') throw new ExpediceBeziError();
    throw err;
  }
}

/** Další pokus po chybě. Compare-and-set: kdo neuspěje, nemá co dělat. */
export async function prevezmiBeh(sql, dnesni) {
  try {
    const [row] = await sql`
      UPDATE warehouse_dispatches
      SET status = 'probiha', attempt = attempt + 1, started_at = NOW(),
          error = '', email_sent_at = NULL, finished_at = NULL
      WHERE id = ${dnesni.id} AND status = 'chyba'
      RETURNING *`;
    return row ?? null;
  } catch (err) {
    if (err.code === '23505') return null;  // mezitím se rozběhl ruční běh
    throw err;
  }
}

/** Odvolá razítka, která nasadil tenhle běh. Ručního označení se nedotkne. */
async function odrazitkuj(sql, dispatchId) {
  await sql`
    UPDATE shop_orders
    SET warehouse_sent_at = NULL, warehouse_dispatch_id = NULL, modified_at = NOW()
    WHERE warehouse_dispatch_id = ${dispatchId} AND warehouse_sent_by IS NULL`;
}

async function oznacChybu(sql, dispatch, chyba) {
  await odrazitkuj(sql, dispatch.id);
  await sql`
    UPDATE warehouse_dispatches
    SET status = 'chyba', error = ${String(chyba).slice(0, 500)}, finished_at = NOW()
    WHERE id = ${dispatch.id}`;
}

/** Poslední krok běhu. Volá se i po restartu u běhu, jehož e-mail už odešel. */
export async function dokonciBeh(sql, dispatch) {
  const [row] = await sql`
    UPDATE warehouse_dispatches
    SET status = 'odeslano', finished_at = NOW()
    WHERE id = ${dispatch.id}
    RETURNING *`;
  return row ?? null;
}

/** Od kdy se sbírá — začátek posledního doběhlého běhu, jinak nic. */
async function zacatekObdobi(sql, shop, dispatch) {
  const [row] = await sql`
    SELECT started_at FROM warehouse_dispatches
    WHERE shop_id = ${shop.id} AND status IN ('odeslano', 'prazdno') AND id <> ${dispatch.id}
    ORDER BY started_at DESC LIMIT 1`;
  return row?.started_at ?? null;
}

/**
 * Push o objednávkách, které skladu nešly. Dedupe na sedm dní podle
 * objednávky — objednávka bez výdejního místa by jinak bzučela každé ráno.
 */
async function oznamPozastavene(sql, pozastavene, log, shop) {
  const nove = [];

  for (const polozka of pozastavene) {
    const [uz] = await sql`
      SELECT 1 FROM notification_log
      WHERE event_type = 'expedice_blokovana' AND event_key = ${String(polozka.order.id)}
        AND sent_at > NOW() - INTERVAL '7 days'
      LIMIT 1`;
    if (uz) continue;

    nove.push(polozka);
    await sql`
      INSERT INTO notification_log (event_type, event_key, message)
      VALUES ('expedice_blokovana', ${String(polozka.order.id)},
              ${`#${polozka.order.order_number}: ${DUVODY_POZASTAVENI[polozka.reason] ?? polozka.reason}`})`;
  }

  if (!nove.length) return;

  const vypis = nove.slice(0, 5)
    .map(p => `#${p.order.order_number} — ${DUVODY_KRATCE[p.reason] ?? p.reason}`)
    .join('; ');

  // U Toneráčku beze změny; u dalších e-shopů jméno v titulku a odkaz na
  // jejich seznam — jinak by push o objednávkách Dílny otevřel Toneráček.
  const jinyEshop = shop && shop.slug !== VYCHOZI_ESHOP;
  await sendPushToAll({
    title: jinyEshop
      ? `Expedice do skladu (${shop.name}): zadržené objednávky`
      : 'Expedice do skladu: zadržené objednávky',
    body: vypis + (nove.length > 5 ? ` a dalších ${nove.length - 5}` : ''),
    url: '/ucetnictvi/objednavky?sklad=blokovano'
      + (jinyEshop ? `&eshop=${encodeURIComponent(shop.slug)}` : ''),
  }, 'expedice').catch(err => log?.warn?.({ err }, 'Push o zadržených objednávkách neodešel'));
}

/**
 * Jeden běh nad už zabraným řádkem. Vrací, co se stalo — volající to jen
 * ukáže obsluze, stav je vždycky v databázi.
 */
export async function spustExpedici(sql, log, { shop, dispatch }) {
  try {
    return await provedExpedici(sql, log, { shop, dispatch });
  } catch (err) {
    log?.error?.({ err, dispatchId: dispatch.id }, 'Běh expedice spadl');
    const [aktualni] = await sql`SELECT email_sent_at FROM warehouse_dispatches WHERE id = ${dispatch.id}`;
    if (aktualni?.email_sent_at) {
      // E-mail skladu odešel, spadlo až dopsání evidence. Razítka musí zůstat,
      // jinak by objednávky zítra odešly podruhé.
      await sql`UPDATE warehouse_dispatches SET status = 'odeslano', finished_at = NOW() WHERE id = ${dispatch.id}`;
      return { status: 'odeslano', orderCount: 0, heldCount: 0, error: err.message };
    }
    await oznacChybu(sql, dispatch, err.message);
    return { status: 'chyba', orderCount: 0, heldCount: 0, error: err.message };
  }
}

async function provedExpedici(sql, log, { shop, dispatch }) {
  const objednavky = await najdiObjednavkyKExpedici(sql, shop);

  if (!objednavky.length) {
    await sql`
      UPDATE warehouse_dispatches
      SET status = 'prazdno', finished_at = NOW(), order_count = 0, held_count = 0
      WHERE id = ${dispatch.id}`;
    return { status: 'prazdno', orderCount: 0, heldCount: 0 };
  }

  // ── Balíky: u převodu zásilka do téhle chvíle vůbec nemusí existovat ──
  let brand = null;
  try {
    brand = await brandForShopId(shop.id);
  } catch (err) {
    log?.error?.({ err, shop: shop.slug }, 'Identita e-shopu chybí, balíky se nepodají');
  }

  const pripravene = [];
  const pozastavene = [];

  for (const order of objednavky) {
    const puvodni = String(order.tracking_number ?? '').trim();
    let norm = normalizujCisloZasilky(order.tracking_number);

    if (!norm && puvodni) {
      // Volný text z Airtable. E-shop by odpověděl „už podáno“ a nic by se nespravilo.
      pozastavene.push({ order, reason: 'neplatne-cislo-zasilky', prechodne: false });
      continue;
    }

    if (!norm && !String(order.pickup_point_id ?? '').trim()) {
      pozastavene.push({ order, reason: 'bez-vydejniho-mista', prechodne: false });
      continue;
    }

    if (!norm) {
      if (!brand) {
        pozastavene.push({ order, reason: 'balik-nepodan', prechodne: true });
        continue;
      }
      const vysledek = await pozadejEshopOPodaniBaliku(log, brand, order);
      const [cerstva] = await sql`SELECT tracking_number FROM shop_orders WHERE id = ${order.id}`;
      norm = normalizujCisloZasilky(cerstva?.tracking_number);

      if (!norm) {
        pozastavene.push({
          order, reason: 'balik-nepodan',
          prechodne: !TRVALE_HTTP.includes(vysledek.httpStatus),
        });
        continue;
      }
      order.tracking_number = cerstva.tracking_number;
    }

    pripravene.push({ order, norm });
  }

  // ── Štítky ──
  const prilohy = [];
  const kExpedici = [];

  for (const { order, norm } of pripravene) {
    try {
      const pdf = await fetchPacketLabelPdf(norm);
      prilohy.push({ filename: `stitek-${norm}.pdf`, content: Buffer.from(pdf).toString('base64') });
      kExpedici.push({ order, norm });
    } catch (err) {
      log?.error?.({ err, order: order.order_number, zasilka: norm },
        'Štítek se nepodařilo stáhnout');
      pozastavene.push({ order, reason: 'stitek-nestazen', prechodne: true });
    }
  }

  await ulozPozastavene(sql, pozastavene);

  if (!kExpedici.length) {
    const prechodna = pozastavene.some(p => p.prechodne);
    if (prechodna) {
      await sql`
        UPDATE warehouse_dispatches
        SET status = 'chyba', finished_at = NOW(), order_count = 0, held_count = ${pozastavene.length},
            error = ${`Žádnou zásilku se nepodařilo připravit, zadržených objednávek: ${pozastavene.length}`}
        WHERE id = ${dispatch.id}`;
      await oznamPozastavene(sql, pozastavene, log, shop);
      return { status: 'chyba', orderCount: 0, heldCount: pozastavene.length };
    }
    await sql`
      UPDATE warehouse_dispatches
      SET status = 'prazdno', finished_at = NOW(), order_count = 0, held_count = ${pozastavene.length}
      WHERE id = ${dispatch.id}`;
    await oznamPozastavene(sql, pozastavene, log, shop);
    return { status: 'prazdno', orderCount: 0, heldCount: pozastavene.length };
  }

  // ── Razítko PŘED odesláním, ať pád procesu nezpůsobí druhý e-mail ──
  const ids = kExpedici.map(x => x.order.id);
  await sql.begin(async tx => {
    await tx`
      UPDATE shop_orders
      SET warehouse_sent_at     = COALESCE(warehouse_sent_at, NOW()),
          warehouse_dispatch_id = COALESCE(warehouse_dispatch_id, ${dispatch.id}),
          warehouse_hold_reason = '',
          modified_at = NOW()
      WHERE id = ANY(${ids}::text[])`;
    await tx`
      UPDATE warehouse_dispatches
      SET order_count = ${ids.length}, held_count = ${pozastavene.length}
      WHERE id = ${dispatch.id}`;
  });

  // ── E-mail ──
  const polozky = await nactiPolozky(sql, ids);
  const skupiny = seskupPodleZasilek(kExpedici.map(x => x.order), polozky);
  const obdobiOd = await zacatekObdobi(sql, shop, dispatch);
  const [issuer] = await sql`SELECT * FROM company_settings LIMIT 1`;
  const { subject, html } = sestavEmail({
    shopName: shop.name, obdobiOd, obdobiDo: new Date(), skupiny,
  });

  let resendId = '';
  try {
    const vysledek = await sendExpediceEmail({
      issuer: issuer || {}, to: shop.warehouse_email, bcc: shop.warehouse_email_bcc || undefined,
      subject, html, attachments: prilohy,
    });
    resendId = vysledek?.id || '';
  } catch (err) {
    log?.error?.({ err, dispatchId: dispatch.id }, 'Expedici se nepodařilo odeslat');
    await odrazitkuj(sql, dispatch.id);
    await sql`
      UPDATE warehouse_dispatches
      SET status = 'chyba', error = ${String(err.message).slice(0, 500)}, subject = ${subject},
          order_count = 0, finished_at = NOW()
      WHERE id = ${dispatch.id}`;
    return { status: 'chyba', orderCount: 0, heldCount: pozastavene.length, error: err.message };
  }

  // ── Bod bez návratu: od téhle chvíle se běh nikdy neposílá znovu ──
  await sql`
    UPDATE warehouse_dispatches
    SET email_sent_at = NOW(), resend_id = ${resendId}, subject = ${subject},
        recipient = ${shop.warehouse_email}
    WHERE id = ${dispatch.id}`;

  await dokonciBeh(sql, dispatch);
  log?.info?.({ dispatchId: dispatch.id, zasilek: skupiny.length, zadrzeno: pozastavene.length, resendId },
    'Expedice do skladu odeslána');

  await oznamPozastavene(sql, pozastavene, log, shop);

  return { status: 'odeslano', orderCount: ids.length, heldCount: pozastavene.length };
}

async function ulozPozastavene(sql, pozastavene) {
  for (const polozka of pozastavene) {
    await sql`
      UPDATE shop_orders
      SET warehouse_hold_reason = ${polozka.reason}, modified_at = NOW()
      WHERE id = ${polozka.order.id}`;
  }
}

// ── Scheduler ─────────────────────────────────────────────────

let bezi = false;

async function zpracujShop(sql, log, shop) {
  const ted = new Date();
  const prazsky = prazskyCas(ted);
  if (!jeVOkne(prazsky)) return;

  const [dnesni] = await sql`
    SELECT * FROM warehouse_dispatches
    WHERE shop_id = ${shop.id} AND kind = 'auto' AND run_date = ${prazsky.datum}
    LIMIT 1`;

  const { akce, duvod } = rozhodniBeh({ dnesni, now: ted });
  if (akce === 'nic') return;

  if (akce === 'dokoncit') {
    await dokonciBeh(sql, dnesni);
    log?.warn?.({ dispatchId: dnesni.id }, 'Expedice dokončena po restartu, e-mail už byl odeslaný');
    return;
  }

  if (akce === 'oznacit-chybu') {
    await oznacChybu(sql, dnesni, duvod);
    log?.warn?.({ dispatchId: dnesni.id }, `Expedice: ${duvod}`);
    return;
  }

  const beh = akce === 'zalozit'
    ? await zalozBeh(sql, { shop, kind: 'auto', runDate: prazsky.datum })
    : await prevezmiBeh(sql, dnesni);
  if (!beh) return;  // jiný tik nebo ruční běh byl rychlejší

  await spustExpedici(sql, log, { shop, dispatch: beh });
}

export async function tikExpedice(log) {
  if (bezi) return;
  bezi = true;
  try {
    const sql = getDb();
    // E-shopy jdou po sobě a Packeta umí odpovídat po desítkách sekund —
    // pevné pořadí s Toneráčkem první, ať mu ranní e-mail nezdrží jiný e-shop.
    // Bez adresy skladu se e-shop přeskakuje jako dřív (expedice vypnutá).
    const shopy = await sql`
      SELECT * FROM shops WHERE active = TRUE AND warehouse_email <> ''
      ORDER BY (slug = ${VYCHOZI_ESHOP}) DESC, id`;
    for (const shop of shopy) {
      try {
        await zpracujShop(sql, log, shop);
      } catch (err) {
        log?.error?.({ err, shop: shop.slug }, 'Ranní expedice selhala');
      }
    }
  } finally {
    bezi = false;
  }
}

export function startExpediceScheduler(log) {
  const tik = () => tikExpedice(log).catch(err => log?.error?.({ err }, 'expedice tick error'));
  setTimeout(tik, 20_000);
  setInterval(tik, 5 * 60_000);
}
