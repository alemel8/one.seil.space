# Režim úprav: co po revizi zůstalo otevřené

Revize z 31. 10. 2026. Opravené nálezy jsou v historii větve, tady je jen to,
co čeká na rozhodnutí nebo se vědomě neřešilo.

## Čeká na rozhodnutí

- **Tlačítko Spárovat v bance nikdy nefungovalo.** Banka se zatím nestahuje, takže
  se to teď neřeší (rozhodnutí z 31. 10. 2026). `views/pages/accounting/bank.ejs`
  volá `openModal`, která je jen uvnitř closure v `public/js/app.js`, klik skončí
  chybou. Výstup modalu je už escapovaný. Zprovoznění je `window.openModal =
  openModal` v `app.js` a `COALESCE(NULLIF(client_name,''), supplier, '')`
  v `GET /api/banka/doklady`, jinak budou přijaté faktury bez názvu. Spustí to
  ruční párování, které označuje faktury jako zaplacené a v provozu ještě neběželo.
  Odkaz `?parovat=` z `received-detail.ejs` zatím nikdo nečte.
- **Poslední zápis vyhrává.** Formulář ze starší stránky přepíše, co někdo mezitím
  změnil, včetně přepínačů Správce a Aktivní účet na záložce Detail. Úplné řešení je
  kontrola `updated_at` při ukládání, v aplikaci zatím nemá předlohu.

## Drobnosti, které se neřešily

- `POST /profil` přijme nové heslo libovolné délky, `/lide/tym/vytvorit` chce aspoň
  8 znaků.
- Našeptávač účtů skládá `innerHTML` z názvů v účetní osnově (čtyři šablony). Osnovu
  píše jen správce. Nesprávce dostane z `/api/accounting-chart` 403, takže má
  našeptávač tiše prázdný.
- Poznámky firmy jdou upravit na dvou záložkách a formulář Základní informace je
  přepisuje hodnotou z načtení stránky.
- Výchozí stát „Česká republika“ se při prvním uložení zapíše i do prázdného sloupce.
  Stejně to dělal dřívější modal.
- Povinné textové pole ze samých mezer hlídá prohlížeč (`pattern`), server ho při
  ručním POST přijme.
- Detail kontaktu (`views/pages/crm/contact-detail.ejs`) tužku nemá, i když
  `POST /crm/kontakty/:id` existuje.

## Neověřeno

Vše běželo v Chromiu přes Puppeteer. Safari, Firefox ani skutečný telefon ověřené
nejsou. Týká se to hlavně počítání dvojkliku (`e.detail`) na dotykovém displeji
a dialogu `beforeunload`, který iOS Safari nemusí ukázat. Záchranou proti přepisu
z ARES je i bez toho dotaz před synchronizací.
