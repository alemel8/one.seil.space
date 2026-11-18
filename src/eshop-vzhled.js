/**
 * Vzhled e-shopu v přehledech administrace: logo v prvním sloupci tabulek,
 * dlaždice přepínače a barva grafu. Bere se z identity e-shopu
 * (shops.logo_mark_url, shops.color_primary z migrace 030), kterou vyplňuje
 * Nastavení → Eshopy – žádné logo ani barva tu nejsou natvrdo.
 *
 * Hodnoty píše člověk do formuláře a jdou do atributů `src` a `style`, proto
 * projdou kontrolou: barva jen jako hex, logo jen přes http(s). Co kontrolou
 * neprojde, nahradí barva SEILu a iniciála názvu.
 */

/** Barva, kterou dostane e-shop bez vlastní (Petrol z brandu SEIL). */
export const VYCHOZI_BARVA = '#0F7E89';

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Hex barva e-shopu, nebo výchozí. */
export function barvaEshopu(hodnota) {
  const h = String(hodnota ?? '').trim();
  return HEX.test(h) ? h : VYCHOZI_BARVA;
}

/** Adresa loga jen s http(s); jinak prázdná a místo obrázku je iniciála. */
export function logoEshopu(hodnota) {
  const h = String(hodnota ?? '').trim();
  if (!h) return '';
  try {
    const url = new URL(h);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

/** První písmeno názvu (bez „www.“), pro e-shop bez loga. */
export function inicialaEshopu(nazev) {
  const n = String(nazev ?? '').trim().replace(/^www\./i, '');
  return (n.match(/\p{L}|\p{N}/u)?.[0] ?? '?').toUpperCase();
}

/** Řádek e-shopu doplněný o `barva`, `logo` a `iniciala` pro šablony. */
export function sVzhledem(eshop) {
  return {
    ...eshop,
    barva: barvaEshopu(eshop.color_primary),
    logo: logoEshopu(eshop.logo_mark_url),
    iniciala: inicialaEshopu(eshop.name),
  };
}
