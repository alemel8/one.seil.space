#!/usr/bin/env bash
#
# Import faktur z POHODY a bankovních výpisů do produkční databáze.
#
#   ./scripts/import.sh --dry-run     nic neuloží, jen vypíše, co by se stalo
#   ./scripts/import.sh               naimportuje
#
# Přepínače se předají oběma importům, takže projde i:
#   ./scripts/import.sh --sync-status
#
# Proč tunel: produkční Postgres nepřijímá spojení odsud (pg_hba), projekt
# zase na VPS vůbec není (Coolify staví images) a data v import/ nejsou
# v gitu. Import proto běží lokálně a k databázi se dostane SSH tunelem
# přes VPS. Tunel se otevře i zavře sám, i když import spadne.
#
# Konfigurace přes prostředí:
#   SSH_USER      uživatel na VPS (výchozí ales)
#   TUNNEL_PORT   lokální port tunelu (výchozí 55433)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SSH_USER="${SSH_USER:-ales}"
TUNNEL_PORT="${TUNNEL_PORT:-55433}"

# Cíl tunelu se bere z DATABASE_URL v .env — hostitel databáze je i VPS,
# kam se tuneluje, takže není co konfigurovat dvakrát.
TUNNEL_INFO="$(TUNNEL_PORT="$TUNNEL_PORT" node --input-type=module -e '
  import "./scripts/lib/load-env.js";
  const raw = process.env.DATABASE_URL;
  if (!raw) { console.error("DATABASE_URL není v .env"); process.exit(1); }
  const u = new URL(raw);
  const host = u.hostname, port = u.port || "5432";
  u.hostname = "127.0.0.1";
  u.port = process.env.TUNNEL_PORT;
  process.stdout.write(`${host} ${port} ${u.toString()}`);
')"
read -r DB_HOST DB_PORT TUNNEL_URL <<< "$TUNNEL_INFO"

SSH_TARGET="$SSH_USER@$DB_HOST"
CTL="$(mktemp -u "${TMPDIR:-/tmp}/import-tunnel.XXXXXX")"

echo "▸ tunel 127.0.0.1:$TUNNEL_PORT → $DB_HOST:$DB_PORT (přes $SSH_TARGET)"
ssh -M -S "$CTL" -f -N \
    -o ExitOnForwardFailure=yes -o ConnectTimeout=10 \
    -L "$TUNNEL_PORT:localhost:$DB_PORT" "$SSH_TARGET"

# Zavřít tunel za sebou vždy — i při chybě, i při Ctrl-C
cleanup() { ssh -S "$CTL" -O exit "$SSH_TARGET" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

export DATABASE_URL="$TUNNEL_URL"
export DATABASE_SSL=false   # spojení šifruje SSH

echo "▸ faktury z POHODY"
node scripts/import-faktury-xlsx.js "$@"

echo
echo "▸ bankovní výpisy"
node scripts/import-vypisy-csv.js "$@"

echo
echo "▸ hotovo, tunel se zavírá"
