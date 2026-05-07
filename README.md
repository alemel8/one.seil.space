# app.seil.space

Interní VPS monitoring dashboard. Heslem chráněná webová aplikace, která ukazuje
aktuální stav serveru `db.seil.cz` (RAM, CPU, disk, PostgreSQL databáze, Docker
kontejnery, SSL certifikáty, poslední backup) plus historii za posledních
72 hodin v grafech.

Slouží jako **referenční implementace** standardního deploy patternu pro
seil.space – Node.js + Docker + GitHub + Coolify.

## Jak to funguje

```
┌─────────────────────────────────────┐
│ VPS host                            │
│                                     │
│  vps-stats-collector (cron 1h)      │
│         │                           │
│         ▼                           │
│  /var/lib/vps-stats/                │
│   ├── latest.json     ◀──── read   │
│   └── history.sqlite  ◀──── read   │
│         ▲                    │      │
│         │            ┌───────┴───┐  │
│         └─ write ────┤ Coolify   │  │
│                      │ Docker:   │  │
│                      │ Fastify   │──┼──── HTTPS
│                      │ + EJS     │  │     basic auth
│                      └───────────┘  │     app.seil.space
└─────────────────────────────────────┘
```

Dvě komponenty:

1. **Collector** (`src/collector.js`) – Node.js skript spouštěný cronem
   přímo na hostu (ne v Dockeru, potřebuje přístup k `/proc`, `docker`,
   `psql`). Sbírá data, zapisuje JSON snapshot a appenduje do SQLite.
2. **Web app** (`src/server.js`) – Fastify server běžící v Docker kontejneru
   spravovaném Coolify. Bind-mountuje `/var/lib/vps-stats` read-only.
   Renderuje dashboard přes EJS.

## Lokální development

```bash
cp .env.example .env
# Vyplň DASHBOARD_PASSWORD

npm install

# 1. Spusť collector aspoň jednou (potřebuješ Linux host nebo Docker)
node src/collector.js

# 2. Spusť server
npm run dev
# Otevři http://localhost:3000
# Login: admin / heslo z .env
```

Na macOS collector některé metriky neumí (chybí `/proc`, `psql`, `docker` v PATH apod.) – v dashboardu uvidíš místa s `null`. Pro plný development použij Docker:

```bash
docker compose up
```

## Nasazení do produkce přes Coolify

### Předpoklad: jednorázová příprava VPS

V `scripts/install-collector.sh` je hotový instalátor. Na VPS (jako root):

```bash
ssh root@89.221.219.220
git clone https://github.com/<tvůj-uživatel>/app.seil.space.git /opt/app.seil.space
bash /opt/app.seil.space/scripts/install-collector.sh
```

Co skript dělá:

- Vytvoří `/var/lib/vps-stats/` (kam collector zapisuje)
- Nastaví cron joby v `/etc/cron.d/vps-stats-collector` (1× za hodinu)
- Spustí collector hned napoprvé, aby `latest.json` existoval

### Coolify projekt

1. V Coolify → New Resource → Public/Private Repository
2. URL: `git@github.com:<user>/app.seil.space.git`
3. Branch: `main`
4. Build Pack: **Dockerfile** (existuje v repu)
5. Domains: `app.seil.space` (Coolify automaticky vyřídí HTTPS přes Caddy)
6. **Volume mounts**:
   - Host path: `/var/lib/vps-stats`
   - Container path: `/var/lib/vps-stats`
   - Mode: **read-only** (kritické – web app nemá zapisovat)
7. **Environment variables**:
   - `DASHBOARD_USER` = `admin` (nebo libovolné)
   - `DASHBOARD_PASSWORD` = (vygeneruj v password manageru, ulož tam)
   - `TZ` = `Europe/Prague`
   - `STATS_DIR` = `/var/lib/vps-stats`
8. Klik **Deploy**.

Pak každý `git push origin main` = automatický redeploy. Nic jiného.

## Standardní deploy pattern pro všechny budoucí aplikace

Tato aplikace je vzor. Pro jakoukoli další (klientskou ERP, tvoji vlastní app, statický web, ...) postupuj stejně:

1. **GitHub repo** s kódem
2. **Dockerfile** v rootu (nebo nech Coolify Nixpacks automaticky)
3. **`.env.example`** dokumentující potřebné env proměnné
4. **`README.md`** s krátkým popisem
5. V **Coolify** přidej jako resource → vyplň env → klikni Deploy
6. Subdoména a HTTPS se vyřeší samy

Existující legacy věci (toneracek na PM2, grapenet docker-compose mimo Coolify):
převést postupně do tohoto vzoru, ne najednou.

## Bezpečnost

- **Nikdy** necommituj `.env`, `data/`, `*.sqlite` do gitu (`.gitignore` to řeší).
- **Heslo** spravuj v password manageru. Coolify env je nečte odjinud.
- **Basic auth** je dostatečná za HTTPS (Coolify+Caddy zajistí). Pro pokročilejší
  scénáře (víc uživatelů, audit log) se to dá rozšířit na session-based auth později.
- **Collector běží jako root** kvůli přístupu ke všem statistikám. Web app jako
  unprivileged uživatel `app` v Dockeru, čte jen volume read-only.

## Roadmap (brzy)

- [ ] `Healthchecks.io` ping z collectoru – upozornění když cron nepoběží
- [ ] Discord/Slack webhook při kritických prahových hodnotách (disk > 90 %, RAM > 95 %)
- [ ] Histogram backupů + alert pokud chybí > 26 h
- [ ] Per-aplikace HTTP healthchecks (curl + status code)
- [ ] PostgreSQL slow query log shrnutí
- [ ] Export historie do CSV
