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
| `ANTHROPIC_API_KEY` | Claude API pro AI analýzu účtenek |
| `VAPID_PUBLIC_KEY` | Web Push public key |
| `VAPID_PRIVATE_KEY` | Web Push private key |
| `VAPID_EMAIL` | Kontaktní e-mail pro VAPID (`mailto:info@seil.cz`) |
| `TONERACEK_API_KEY` | Bearer token pro webhook z Toneráček.cz |
| `STATS_DIR` | Adresář s VPS stats (`/var/lib/vps-stats`) |

### Generování VAPID klíčů (jednorázové)
```bash
node -e "import('web-push').then(wp => { const k = wp.default.generateVAPIDKeys(); console.log(k); })"
```

---

## Coolify — nové nasazení

1. New Resource → Git repository
2. Branch: `main`, Build Pack: **Dockerfile**
3. Domain: `one.seil.space` (Coolify vyřídí HTTPS)
4. Volume mounts:
   - Host `/var/lib/vps-stats` → Container `/var/lib/vps-stats` (read-only)
   - Host `/data/one-seil/media` → Container `/app/data/media`
5. Nastavit všechny env proměnné
6. Deploy

Každý `git push origin main` → automatický redeploy.

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
- API klíče pro e-shopy jsou 64 hex znaků (256 bit entropie)
- File uploads: validace MIME type, max 20 MB
- SQL injection: parametrizované dotazy přes `postgres` library (template literals)
- Puppeteer/Chromium: sandbox vypnut kvůli Dockeru (`--no-sandbox`)

---

## PWA a push notifikace

Aplikace je nainstalována jako PWA. Service Worker (`public/sw.js`) zajišťuje:
- Cache pro statické assets
- Příjem a zobrazení push notifikací
- Přesměrování po kliknutí na notifikaci

Aktivace notifikací: `/profil` → karta "Push notifikace" → Povolit notifikace.

Funguje na:
- Android Chrome (PWA i browser)
- iOS Safari 16.4+ (pouze jako nainstalovaná PWA)
- Desktop Chrome/Edge/Firefox
