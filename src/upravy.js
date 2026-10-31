/**
 * Režim úprav na detailech („tužka → Uložit“).
 *
 * Detail záznamu se vykresluje v režimu zobrazení — hodnoty jako text — a po
 * kliknutí na tužku v hlavičce se tatáž pole otevřou k úpravě přímo na
 * stránce. Stav drží atribut `data-rezim="zobrazeni|upravy"` na obalu
 * stránky (nebo karty): přepíná ho public/js/upravy.js, bez JavaScriptu ho
 * nastaví server podle `?upravit=1` (tužka je odkaz, Uložit submit přes
 * `form=`). Pole vykresluje views/includes/pole.ejs, ovládání
 * views/includes/upravit.ejs; popis v docs/moduly.md.
 *
 * Z `error=` se režim neodvozuje: chyba může přijít z úplně jiného formuláře
 * na téže stránce (heslo na profilu, fotka člena, token platformy na
 * marketingu e-shopu) a otevřený formulář marže pod hláškou o tokenu by
 * jen mátl. POST upravitelného formuláře proto při chybě přidá do
 * přesměrování `&upravit=1` sám.
 */
export function rezimUprav(query = {}) {
  return query.upravit === '1';
}
