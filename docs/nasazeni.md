# Nasazení a provoz

## Produkční prostředí

Aplikace běží v **Docker kontejneru** spravovaném přes **Coolify** na VPS `vps.seil.space` (89.221.219.220). HTTPS a Caddy reverse proxy zajišťuje Coolify automaticky.

Databáze PostgreSQL 16 běží jako separátní service na stejném VPS.

---

## Environment proměnné

Viz `.env.example` pro kompletní přehled. Klíčové proměnné:

| Proměnná | Popis |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Min. 32 znaků, náhodný řetězec |
| `COOKIE_SECURE` | `true` v produkci za HTTPS |
| `RESEND_API_KEY` | API klíč pro odesílání e-mailů |
| `MAIL_FROM` | Odesílatel **firemní** pošty (`SEIL s.r.o. <noreply@seil.cz>`). Zákaznické e-maily e-shopů se odsud neberou — identitu mají v tabulce `shops`. |
| `MAIL_REPLY_TO` | Kam chodí odpovědi klientů (`obchod@seil.cz`) |
| `SHOP_SENDS_PAYMENT_EMAIL` | Přechodový přepínač: `1` = zálohovou fakturu už neposílá Seil, ale e-shop v potvrzení objednávky. Zapnout až po nasazení e-shopu. |
| `ANTHROPIC_API_KEY` | Claude API pro AI analýzu účtenek |
| `VAPID_PUBLIC_KEY` | Web Push public key |
| `VAPID_PRIVATE_KEY` | Web Push private key |
| `VAPID_EMAIL` | Kontaktní e-mail pro VAPID (`mailto:info@seil.cz`) |
| `TONERACEK_API_KEY` | Bearer token pro webhook z Toneráček.cz |
| `PACKETA_API_PASSWORD` | Heslo k API Zásilkovny. Bez něj se nestáhnou štítky — ranní expedice objednávky jen zadrží |
| `SHOP_WEBHOOK_SECRET` | Tajemství pro volání zpět do e-shopu **Toneráčku** (podání balíku), shodné s `WEBHOOK_SECRET` v jeho e-shopu. Bez něj se u převodu balík nepodá. Další e-shopy mají vlastní tajemství (detail e-shopu → záložka *Napojení e-shopu*, `shops.webhook_secret`) a tohle nikdy nedostanou |
| `STATS_DIR` | Adresář s VPS stats (`/var/lib/vps-stats`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Celý JSON klíč service accountu Googlu v jedné proměnné. Jeden účet pro import faktur z Google Disku i pro sekci Marketing (GA4, Google Ads, Search Console, Merchant); jeho e-mail se přidává jako čtenář tam, odkud má číst (`src/google-auth.js`) |
| `MARKETING_SECRETS_KEY` | 64 hex znaků pro šifrování tokenů Sklik / Heureka / Meta v databázi (AES-256-GCM); bez něj nejde v nastavení e-shopu uložit token Skliku, Heureky ani Mety. Generuje se `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

### Generování VAPID klíčů (jednorázové)
```bash
node -e "import('web-push').then(wp => { const k = wp.default.generateVAPIDKeys(); console.log(k); })"
```

### Ověření odesílání e-mailů

Doména v `MAIL_FROM` musí být ověřená v Resendu (SPF + DKIM), jinak API zprávy
odmítne. **Totéž platí pro doménu každého e-shopu** (`noreply@toneracek.cz`, …),
která se ověřuje ve stejném Resend účtu — bez ověření dostane zákazník místo
potvrzení objednávky chybu. Kontrola nastavení bez odeslání:

```bash
node scripts/test-email.js                    # v produkčním kontejneru
node --env-file=.env scripts/test-email.js    # lokálně
```

S adresou skript pošle testovací zprávu — hodí se po každé změně klíče
nebo odesílatele:

```bash
node scripts/test-email.js ales@seil.cz
```

---

## Coolify — nové nasazení

1. New Resource → Git repository
2. Branch: `main`, Build Pack: **Dockerfile**
3. Domain: `one.seil.space` (Coolify vyřídí HTTPS)
4. Volume mounts:
   - Host `/var/lib/vps-stats` → Container `/var/lib/vps-stats` (read-only)
   - Host `/data/one-seil/data` → Container `/app/data` — **povinné, viz níže**
5. Nastavit všechny env proměnné
6. Deploy

Každý `git push origin main` → automatický redeploy (a migrace nad živou
databází při startu). Postup pro změnu, na které visí Toneráček — záloha,
kouřový test, návrat — je v [druhy-eshop.md](druhy-eshop.md#nasazení-na-živý-one-seil-servisní-okno).

---

## ⚠ Persistent volume na /app/data

**Bez tohoto mountu každý deploy nenávratně smaže všechny nahrané soubory.**

Dockerfile v obrazu maže `data/` a znovu vytváří prázdný `/app/data`. Co tam
aplikace za běhu zapíše, žije jen v zapisovatelné vrstvě kontejneru — a tu
deploy zahodí i s obsahem. Týká se to:

| Cesta | Obsah | Odkaz v DB |
|---|---|---|
| `/app/data/media` | doklady účtenek a přijatých faktur, profilové fotky | `receipts.attachment_path`, `accounting_invoices.attachment_path`, `users.photo` |
| `/app/data/pdfs` | archiv odeslaných faktur v PDF | `accounting_invoices.pdf_path` |

Záznamy v databázi deploy přežijí, soubory ne — v systému pak zůstane doklad,
který nejde otevřít. Proto se mountuje celý `/app/data`, ne jen `media`.

Kontrola, že je volume opravdu připojený:

```bash
ssh root@89.221.219.220
docker inspect <kontejner> --format '{{json .Mounts}}' | python3 -m json.tool
```

Aplikace to hlásí i sama — při startu porovná soubory na disku s tím, co
eviduje databáze, a chybějící vypíše do logu (`[přílohy]`). Když chybí všechny,
je to ERROR a znamená to přesně tohle.

---

## VPS Stats Collector

Collector (`src/collector.js`) musí běžet **přímo na hostu** (ne v Dockeru) — potřebuje přístup k `/proc`, `docker`, `psql`.

Instalace:
```bash
ssh root@89.221.219.220
git clone <repo> /opt/one.seil.space
bash /opt/one.seil.space/scripts/install-collector.sh
```

Skript nastaví cron v `/etc/cron.d/vps-stats-collector` (každou hodinu) a spustí collector poprvé.

Výstup collectoru:
- `/var/lib/vps-stats/latest.json` — aktuální snapshot
- `/var/lib/vps-stats/history.sqlite` — 72h+ historie pro grafy

---

## Lokální vývoj

```bash
cp .env.example .env
# Vyplň DATABASE_URL a SESSION_SECRET

npm install
npm run dev
# Server na http://localhost:3000
```

Vytvoření prvního admin uživatele:
```bash
node scripts/create-superuser.js
```

### Docker Compose (lokálně)
```bash
docker compose up
# Spustí app + PostgreSQL
```

---

## Migrace databáze

Migrace se spustí automaticky při každém startu serveru. Manuálně:
```bash
node -e "import('./src/migrate.js').then(m => m.runMigrations(...))"
```

Nová migrace: přidej soubor `migrations/0NN_název.sql`. Bude aplikována při příštím startu.

---

## Bezpečnost

- `.env`, `data/`, `*.sqlite` jsou v `.gitignore` — nikdy necommituj
- Session uložena v PostgreSQL, httpOnly cookies
- Admin přístup je hlídán v každé route zvlášť (`request.user.is_admin`)
- API klíče pro e-shopy jsou 64 hex znaků (256 bit entropie), v databázi jen SHA-256 otisk (`eshop_api_keys`)
- File uploads: validace MIME type, max 20 MB
- SQL injection: parametrizované dotazy přes `postgres` library (template literals)
- Puppeteer/Chromium: sandbox vypnut kvůli Dockeru (`--no-sandbox`)

---

## Vendorované knihovny ve `public/`

`public/chart.umd.min.js` je **Chart.js 4.4.7** — UMD build
`dist/chart.umd.js` z npm balíčku `chart.js@4.4.7` beze změny (licence MIT,
hlavička s verzí je v souboru; SHA-256
`2812cb8825fdc57469eb2f7bb055e9429244e599920511ee477e828499b632cb`). Kreslí
grafy na `/monitoring`, `/ucetnictvi/prehled` a v sekci Marketing; do
29. 10. 2026 tu ležel 431bajtový stub, který jen varoval do konzole, takže
grafy nic nekreslily. Aktualizace: stáhnout týž soubor novější verze
(`curl -L https://cdn.jsdelivr.net/npm/chart.js@<verze>/dist/chart.umd.js`),
ověřit `Chart.js v<verze>` v hlavičce a **zvednout `CACHE_NAME`
v `public/sw.js`** — nainstalovaná PWA jinak drží starou kopii. Chart.js
kreslí do canvasu a CSS proměnné nezná, barvy grafů se zadávají hexem.

---

## PWA a push notifikace

Aplikace je nainstalována jako PWA. Service Worker (`public/sw.js`) zajišťuje:
- Cache pro statické assets
- Příjem a zobrazení push notifikací
- Přesměrování po kliknutí na notifikaci

### Rozložení (sidebar, topbar)

Levé menu jde na desktopu sbalit do ikonového pruhu — přepínač je vlevo
v horní liště, na mobilu totéž tlačítko otevírá drawer. Stav drží
`localStorage['seil-sidebar']` a atribut `data-sidebar="collapsed"` na
`<html>`, který — stejně jako `data-theme` — nastavuje inline skript
v `views/layouts/base.ejs` ještě před načtením stylů, aby stránka
nebliknula. Sbalený vzhled je v `public/css/layout.css` v bloku
`@media not all and (max-width: 768px)`, přesném doplňku mobilního bloku;
tutéž hranici používá `matchMedia` v `public/js/app.js`. Sbalená skupina
je jedna ikona a vede na svou první podstránku.

Aktivace notifikací: `/profil` → karta "Push notifikace" → Povolit notifikace.

Funguje na:
- Android Chrome (PWA i browser)
- iOS Safari 16.4+ (pouze jako nainstalovaná PWA)
- Desktop Chrome/Edge/Firefox
