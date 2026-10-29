/**
 * Složení marketingového přehledu z načtených dat — čistá funkce bez
 * databáze, aby šla stránka /marketing otestovat nad připravenými řádky
 * a aby routa jen načítala a vykreslovala.
 *
 * Vstup jsou výsledky SQL pomocníků z kpi.js (objednávky, položky, náklady
 * API, ruční náklady, řady po dnech, funnel GA4, rozpad kanálů GA4,
 * organika, Merchant, konverze platforem, statistiky e-shopu) a zdroje
 * z zdroje.js; výstup jsou hotová čísla pro dlaždice, tabulky, graf
 * a varování. Definice KPI jsou v hlavičce kpi.js — tady se jen skládají.
 *
 * ## Kanál × platforma
 *
 * Náklady leží po platformách (`marketing_daily_stats.platform`), objednávky
 * po kanálech (`kanalObjednavky`). Placená platforma odpovídá jednomu kanálu
 * 1:1 (google_ads → google_ads, …); ruční náklad „ostatni“ padá do
 * „placené ostatní“. GA4, Search Console, Merchant a e-shop náklady nemají,
 * v tabulce kanálů tedy nefigurují.
 */

import {
  KANALY, KANAL_POPIS, bezDph, marzeObjednavek, porovnej, prekryvRucnichNakladu,
  radyProGraf, rozdelPodleKanalu, rozpoctiManualniNaklad, rozpoctiManualniNakladPoDnech,
  seskupKanalyGa4, spoctiKpi,
} from './kpi.js';
import { zaokrouhli2 } from './normalizace.js';
import { jenDatum, pridejDny } from '../prazsky-cas.js';

export const PLATFORMA_POPIS = {
  ga4: 'Google Analytics 4', google_ads: 'Google Ads', search_console: 'Search Console',
  merchant: 'Merchant Center', sklik: 'Sklik', zbozi: 'Zboží.cz', heureka: 'Heureka',
  meta: 'Meta (Facebook, Instagram)', eshop: 'E-shop', ostatni: 'Ostatní',
};

/** Platforma nákladů → kanál objednávek. Platformy bez nákladů tu nejsou. */
export const PLATFORMA_KANAL = {
  google_ads: 'google_ads', sklik: 'sklik', zbozi: 'zbozi', heureka: 'heureka', meta: 'meta', ostatni: 'placene_jine',
};

/** Po kolika dnech bez úspěšného stažení se zdroj hlásí jako zastaralý. */
export const ZASTARALY_PO_DNECH = 2;

const soucet = (pole, klic) => pole.reduce((s, r) => s + (Number(r?.[klic]) || 0), 0);

function kroky(funnel) {
  const seznam = [
    ['Návštěvy', funnel.sessions],
    ['Zobrazení produktu', funnel.view_item],
    ['Přidání do košíku', funnel.add_to_cart],
    ['Pokladna', funnel.begin_checkout],
    ['Nákup (GA4)', funnel.purchase],
  ];
  return seznam.map(([nazev, hodnota], i) => {
    const predchozi = i > 0 ? Number(seznam[i - 1][1]) || 0 : null;
    const h = Number(hodnota) || 0;
    return {
      nazev, hodnota: h,
      podil: predchozi ? zaokrouhli2(h / predchozi * 100) : null,
      podilZNavstev: Number(seznam[0][1]) > 0 ? zaokrouhli2(h / Number(seznam[0][1]) * 100) : null,
    };
  });
}

/**
 * Varování nad zdroji: chyba posledního běhu, data starší než 2 dny
 * u aktivního zdroje, žádný aktivní zdroj. `dnes` je pražské datum.
 */
export function varovaniZdroju(zdroje, dnes) {
  const varovani = [];
  const aktivni = (zdroje ?? []).filter(z => z.zdroj && z.zdroj.active);
  if (!aktivni.length) {
    varovani.push({ typ: 'nenastaveno', text: 'Žádná platforma není napojená — čísla jsou jen z objednávek a ručních nákladů.' });
    return varovani;
  }
  const hranice = pridejDny(dnes, -ZASTARALY_PO_DNECH);
  for (const z of aktivni) {
    const okDen = z.zdroj.last_ok_at ? jenDatum(z.zdroj.last_ok_at) : null;
    if (z.zdroj.last_error) {
      varovani.push({ typ: 'chyba', platform: z.platform, text: `${z.popis}: poslední stažení selhalo — ${String(z.zdroj.last_error).slice(0, 160)}` });
    } else if (!okDen) {
      varovani.push({ typ: 'bez-dat', platform: z.platform, text: `${z.popis}: zatím nic nestaženo (první běh proběhne v noci, nebo spusťte ručně v Synchronizaci).` });
    } else if (okDen < hranice) {
      varovani.push({ typ: 'zastarale', platform: z.platform, text: `${z.popis}: poslední data z ${okDen}.` });
    }
  }
  return varovani;
}

/**
 * Celý přehled. Viz hlavička souboru; `shop` nese `marketing_margin_pct`
 * a `marketing_pno_alert_pct` (čísla), `obdobi` je výstup vyhodnotObdobi().
 */
export function sestavPrehled({
  shop, obdobi, objednavky = [], polozky = [], nakladyApi = [], rucni = [], trzbyDny = [], nakladyDny = [],
  apiDny = [], funnel = {}, kanalyGa4Radky = [], organika = null, merchant = null, konverze = [], eshopDny = [],
  zdroje = [], dnes,
}) {
  const { od, do: do_ } = obdobi;

  // Tržby a objednávky
  const trzbySDph = soucet(objednavky, 'total_price');
  const trzbyBezDph = bezDph(trzbySDph);
  const zaplacene = objednavky.filter(o => o.zaplaceno === true);
  const zaplacenoBezDph = bezDph(soucet(zaplacene, 'total_price'));

  // Náklady: API po platformách + ruční rozpočítané na období
  const nakladyPlatforem = new Map();
  for (const r of nakladyApi) nakladyPlatforem.set(r.platform, { api: Number(r.naklady) || 0, rucni: 0, sDph: Number(r.naklady_s_dph) || 0 });
  let rucniCelkem = 0;
  const rucniPoDnech = {};
  for (const n of rucni) {
    const castka = rozpoctiManualniNaklad(n, od, do_);
    rucniCelkem += castka;
    const z = nakladyPlatforem.get(n.platform) ?? { api: 0, rucni: 0, sDph: 0 };
    z.rucni += castka;
    nakladyPlatforem.set(n.platform, z);
    for (const [den, c] of Object.entries(rozpoctiManualniNakladPoDnech(n, od, do_))) rucniPoDnech[den] = (rucniPoDnech[den] ?? 0) + c;
  }
  const nakladyApiCelkem = soucet(nakladyApi, 'naklady');
  const nakladyCelkem = zaokrouhli2(nakladyApiCelkem + rucniCelkem);
  const nakladyRadky = [...nakladyPlatforem.entries()]
    .map(([platform, z]) => ({ platform, popis: PLATFORMA_POPIS[platform] ?? platform, api: zaokrouhli2(z.api), rucni: zaokrouhli2(z.rucni), celkem: zaokrouhli2(z.api + z.rucni) }))
    .filter(r => r.celkem > 0)
    .sort((a, b) => b.celkem - a.celkem);

  // Marže a KPI
  const marze = marzeObjednavek(polozky, shop?.marketing_margin_pct);
  const maMarzi = (marze.trzbyZbozi - marze.bezMarze) > 0;
  const kpiHodnoty = spoctiKpi({ trzbyBezDph, pocetObjednavek: objednavky.length, naklady: nakladyCelkem, marze: maMarzi ? marze.marze : null });
  const prah = Number(shop?.marketing_pno_alert_pct) || 0;
  const pnoPrekrocen = kpiHodnoty.pno != null && prah > 0 && kpiHodnoty.pno > prah;

  // Kanály: objednávky Seil × náklady × konverze platforem
  const { kanaly, pokrytiAtribuce } = rozdelPodleKanalu(objednavky);
  const konverzePlatforem = new Map(konverze.map(k => [k.platform, k]));
  const nakladyKanalu = Object.fromEntries(KANALY.map(k => [k, 0]));
  const konverzeKanalu = {};
  for (const [platform, z] of nakladyPlatforem) {
    const kanal = PLATFORMA_KANAL[platform];
    if (kanal) nakladyKanalu[kanal] += z.api + z.rucni;
  }
  for (const [platform, k] of konverzePlatforem) {
    const kanal = PLATFORMA_KANAL[platform];
    if (!kanal) continue;
    const c = konverzeKanalu[kanal] ?? { conversions: 0, conversion_value: 0 };
    c.conversions += Number(k.conversions) || 0;
    c.conversion_value += Number(k.conversion_value) || 0;
    konverzeKanalu[kanal] = c;
  }
  const kanalRadky = KANALY.map(kanal => {
    const k = kanaly[kanal];
    const naklady = zaokrouhli2(nakladyKanalu[kanal]);
    const platforma = konverzeKanalu[kanal] ?? null;
    return {
      kanal, popis: KANAL_POPIS[kanal], pocet: k.pocet, trzbyBezDph: k.trzbyBezDph, naklady,
      pno: k.trzbyBezDph > 0 && naklady > 0 ? zaokrouhli2(naklady / k.trzbyBezDph * 100) : null,
      platforma: platforma ? { conversions: zaokrouhli2(platforma.conversions), conversion_value: zaokrouhli2(platforma.conversion_value) } : null,
      porovnaniObjednavek: platforma ? porovnej(k.pocet, platforma.conversions) : null,
      porovnaniTrzeb: platforma ? porovnej(k.trzbyBezDph, platforma.conversion_value) : null,
    };
  }).filter(r => r.pocet > 0 || r.naklady > 0 || r.platforma);

  // Graf
  const graf = radyProGraf({
    od, do: do_, trzbyPoDnech: trzbyDny,
    nakladyPoDnech: [...nakladyDny, ...Object.entries(rucniPoDnech).map(([den, castka]) => ({ den, castka }))],
  });

  // GA4
  const funnelPlne = { sessions: 0, total_users: 0, view_item: 0, add_to_cart: 0, begin_checkout: 0, purchase: 0, purchase_revenue: 0, dni: 0, ...funnel };
  const funnelKroky = kroky(funnelPlne);
  const ga4Kanaly = seskupKanalyGa4(kanalyGa4Radky);
  const ga4KanalRadky = KANALY
    .map(k => ({ kanal: k, popis: KANAL_POPIS[k], ...ga4Kanaly[k] }))
    .filter(r => r.sessions > 0 || r.purchase > 0)
    .sort((a, b) => b.sessions - a.sessions);
  const maGa4 = funnelPlne.dni > 0;

  // E-shop
  const eshop = {
    dni: eshopDny.length,
    hledaniBezVysledku: soucet(eshopDny, 'searches_no_result'),
    kosiky: soucet(eshopDny, 'carts_abandoned'),
    kosikyHodnota: zaokrouhli2(soucet(eshopDny, 'carts_value')),
  };

  // Varování
  const varovani = varovaniZdroju(zdroje, dnes);
  for (const p of prekryvRucnichNakladu(rucni, apiDny, od, do_)) {
    varovani.push({ typ: 'prekryv', platform: p.platform, text: `${PLATFORMA_POPIS[p.platform] ?? p.platform}: ruční náklad i data z API pro ${p.dny.length} ${p.dny.length === 1 ? 'den' : 'dní'} (${p.dny[0]}–${p.dny[p.dny.length - 1]}) — v součtu je obojí.` });
  }

  return {
    trzby: { sDph: zaokrouhli2(trzbySDph), bezDph: trzbyBezDph, pocet: objednavky.length, zaplacenoPocet: zaplacene.length, zaplacenoBezDph },
    naklady: { celkem: nakladyCelkem, api: zaokrouhli2(nakladyApiCelkem), rucni: zaokrouhli2(rucniCelkem), radky: nakladyRadky },
    marze: { ...marze, maMarzi, odhadPct: Number(shop?.marketing_margin_pct) || 0 },
    kpi: kpiHodnoty,
    prahPno: prah,
    pnoPrekrocen,
    kanaly: { radky: kanalRadky, pokrytiAtribuce },
    graf,
    ga4: { ma: maGa4, funnel: funnelPlne, kroky: funnelKroky, porovnaniNakupu: maGa4 ? porovnej(objednavky.length, funnelPlne.purchase) : null, kanaly: ga4KanalRadky, ukazatKanaly: pokrytiAtribuce < 1 && ga4KanalRadky.length > 0 },
    organika: organika ?? { celkem: { dni: 0, clicks: 0, impressions: 0, pozice: null }, dotazy: [] },
    merchant: merchant ?? { den: null, approved_items: 0, disapproved_items: 0, clicks: 0, impressions: 0, dni: 0 },
    eshop,
    varovani,
  };
}
