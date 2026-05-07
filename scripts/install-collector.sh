#!/bin/bash
# Instalátor pro VPS stats collector.
# Spusť jednou na VPS jako root po `git clone` repa.
#
# Předpoklad:
#   - Repo je naklonované do /opt/app.seil.space
#   - Node.js 20+ je nainstalovaný (apt install nodejs)
#   - psql, docker, curl jsou v PATH

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/app.seil.space}"
STATS_DIR="${STATS_DIR:-/var/lib/vps-stats}"
LOG_DIR="${LOG_DIR:-/var/log}"

echo "===== app.seil.space collector installer ====="
echo "Repo:        $REPO_DIR"
echo "Stats dir:   $STATS_DIR"
echo "Log dir:     $LOG_DIR"
echo

# 1. Sanity checks
for cmd in node npm psql docker curl; do
  if ! command -v "$cmd" >/dev/null; then
    echo "WARN: '$cmd' není v PATH. Některé metriky budou null."
  fi
done

if [ ! -d "$REPO_DIR" ]; then
  echo "FATAL: $REPO_DIR neexistuje. Naklonuj nejdřív repo."
  exit 1
fi

# 2. Stats adresář
mkdir -p "$STATS_DIR"
chmod 755 "$STATS_DIR"

# 3. npm install (jen production deps)
echo
echo "--- Instaluji Node.js závislosti ---"
cd "$REPO_DIR"
npm ci --omit=dev

# 4. První spuštění collectoru, aby vznikl latest.json
echo
echo "--- První spuštění collectoru ---"
STATS_DIR="$STATS_DIR" node "$REPO_DIR/src/collector.js" || {
  echo "WARN: První spuštění selhalo. Zkontroluj $LOG_DIR/vps-stats.log."
}

if [ -f "$STATS_DIR/latest.json" ]; then
  echo "OK: $STATS_DIR/latest.json existuje."
else
  echo "WARN: latest.json se nevytvořil."
fi

# 5. Cron job - každou hodinu
CRON_FILE="/etc/cron.d/vps-stats-collector"
echo
echo "--- Instaluji cron $CRON_FILE ---"
cat > "$CRON_FILE" <<EOF
# app.seil.space - VPS stats collector
# Spouští se každou hodinu, výstup do $LOG_DIR/vps-stats.log
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
STATS_DIR=$STATS_DIR

0 * * * * root cd $REPO_DIR && node $REPO_DIR/src/collector.js >> $LOG_DIR/vps-stats.log 2>&1
EOF
chmod 644 "$CRON_FILE"

# Reload cron (různá distra mají různě)
if command -v systemctl >/dev/null && systemctl list-units --type=service | grep -q cron; then
  systemctl reload cron 2>/dev/null || systemctl restart cron
fi

# 6. Logrotate
LOGROTATE_FILE="/etc/logrotate.d/vps-stats"
echo "--- Nastavuji logrotate $LOGROTATE_FILE ---"
cat > "$LOGROTATE_FILE" <<EOF
$LOG_DIR/vps-stats.log {
    weekly
    rotate 4
    compress
    missingok
    notifempty
    copytruncate
}
EOF
chmod 644 "$LOGROTATE_FILE"

# 7. Souhrn
echo
echo "===== HOTOVO ====="
echo
echo "Collector se bude spouštět každou hodinu (v 0. minutě)."
echo "Logy: $LOG_DIR/vps-stats.log"
echo "Data: $STATS_DIR/"
echo
echo "Další kroky:"
echo "  1. Nasaď web app v Coolify (viz README)"
echo "  2. Bind-mount $STATS_DIR do kontejneru jako read-only"
echo "  3. Otevři https://app.seil.space"
