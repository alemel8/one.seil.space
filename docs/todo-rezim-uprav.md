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

## Drobnosti, které se neřešily

- Kontrola při Uložit (`docs/moduly.md`) není atomická a bez JavaScriptu neběží.
  Kdyby to někde vadilo, přidá se serverový otisk sloupců z `UPDATE` na účtenku
  a člena týmu, klient na to už je připravený.
- Formuláře mimo režim úprav kontrolu nemají a dál platí poslední zápis. První na
  řadě je přístupová matice, protože může vrátit odebraná práva, pak úprava vydané
  faktury a kontakt.
- `POST /profil` přijme nové heslo libovolné délky, `/lide/tym/vytvorit` chce aspoň
  8 znaků.
- Našeptávač účtů skládá `innerHTML` z názvů v účetní osnově (čtyři šablony). Osnovu
  píše jen správce. Nesprávce dostane z `/api/accounting-chart` 403, takže má
  našeptávač tiše prázdný.
- Výchozí stát „Česká republika“ se při prvním uložení zapíše i do prázdného sloupce.
  Stejně to dělal dřívější modal.
- Povinné textové pole ze samých mezer hlídá prohlížeč (`pattern`), server ho při
  ručním POST přijme.
- Detail kontaktu (`views/pages/crm/contact-detail.ejs`) tužku nemá, i když
  `POST /crm/kontakty/:id` existuje.

## Neověřeno

Testy projektu běží v Chromiu přes Puppeteer. Kontrola při Uložit je jednorázově
ověřená i ve Firefoxu a WebKitu přes Playwright. Skutečné Safari ani telefon ověřené
nejsou, před větší vlnou úprav z mobilu vyzkoušet cizí Storno na iPhonu. Týká se to
hlavně počítání dvojkliku (`e.detail`) na dotykovém displeji
a dialogu `beforeunload`, který iOS Safari nemusí ukázat. Záchranou proti přepisu
z ARES je i bez toho dotaz před synchronizací.
