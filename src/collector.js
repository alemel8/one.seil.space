// VPS Stats Collector
// Spouští se na hostu (cron, ne v Dockeru) a píše do STATS_DIR.
// Web aplikace pak ta data čte read-only.
//
// Spuštění ručně:    node src/collector.js
// V cronu (na VPS):  0 * * * * cd /opt/one-seil-space && node src/collector.js >> /var/log/vps-stats.log 2>&1

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const STATS_DIR = process.env.STATS_DIR || '/var/lib/vps-stats';

mkdirSync(STATS_DIR, { recursive: true });

function sh(cmd, fallback = '') {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000 }).trim();
  } catch (e) {
    return fallback;
  }
}

function shJson(cmd, fallback = null) {
  const out = sh(cmd);
  if (!out) return fallback;
  try { return JSON.parse(out); } catch { return fallback; }
}

// === COLLECTORS ===

function collectMemory() {
  // /proc/meminfo - Linux only
  if (!existsSync('/proc/meminfo')) return null;
  const meminfo = readFileSync('/proc/meminfo', 'utf8');
  const parse = (key) => {
    const m = meminfo.match(new RegExp(`^${key}:\\s*(\\d+)\\s*kB`, 'm'));
    return m ? parseInt(m[1], 10) : 0;
  };
  const total = parse('MemTotal');
  const available = parse('MemAvailable');
  const swapTotal = parse('SwapTotal');
  const swapFree = parse('SwapFree');
  return {
    total_mb: Math.round(total / 1024),
    available_mb: Math.round(available / 1024),
    used_mb: Math.round((total - available) / 1024),
    swap_total_mb: Math.round(swapTotal / 1024),
    swap_used_mb: Math.round((swapTotal - swapFree) / 1024),
  };
}

function collectCpu() {
  if (!existsSync('/proc/loadavg')) return null;
  const loadavg = readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/);
  const cpus = parseInt(sh('nproc') || '1', 10);
  return {
    load_1m: parseFloat(loadavg[0]),
    load_5m: parseFloat(loadavg[1]),
    load_15m: parseFloat(loadavg[2]),
    cpu_count: cpus,
    load_pct_1m: Math.round((parseFloat(loadavg[0]) / cpus) * 100),
  };
}

function collectDisk() {
  // df výstup root partition
  const out = sh("df -B1 / | tail -1");
  if (!out) return null;
  const parts = out.split(/\s+/);
  // Filesystem  Size  Used  Available  Use%  Mounted
  const total = parseInt(parts[1], 10);
  const used = parseInt(parts[2], 10);
  const avail = parseInt(parts[3], 10);
  return {
    total_gb: Math.round((total / 1024 / 1024 / 1024) * 10) / 10,
    used_gb: Math.round((used / 1024 / 1024 / 1024) * 10) / 10,
    available_gb: Math.round((avail / 1024 / 1024 / 1024) * 10) / 10,
    used_pct: Math.round((used / total) * 100),
  };
}

function collectUptime() {
  if (!existsSync('/proc/uptime')) return null;
  const seconds = parseFloat(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
  return {
    seconds: Math.round(seconds),
    days: Math.floor(seconds / 86400),
    pretty: sh('uptime -p') || `${Math.floor(seconds / 86400)} days`,
  };
}

function collectPostgres() {
  // Spustí jako postgres user
  const dbsRaw = sh(`sudo -u postgres psql -tAc "SELECT datname || '|' || pg_database_size(datname) FROM pg_database WHERE datname NOT IN ('template0','template1') ORDER BY datname;" 2>/dev/null`);
  if (!dbsRaw) return null;
  const databases = dbsRaw.split('\n').filter(Boolean).map(line => {
    const [name, bytes] = line.split('|');
    return {
      name,
      size_mb: Math.round(parseInt(bytes, 10) / 1024 / 1024),
    };
  });
  const totalMb = databases.reduce((sum, d) => sum + d.size_mb, 0);
  const version = sh(`sudo -u postgres psql -tAc "SHOW server_version;" 2>/dev/null`);
  const connections = sh(`sudo -u postgres psql -tAc "SELECT count(*) FROM pg_stat_activity;" 2>/dev/null`);
  return {
    version,
    total_mb: totalMb,
    databases,
    active_connections: parseInt(connections || '0', 10),
  };
}

function collectDocker() {
  if (!sh('which docker')) return null;
  // Spočítá kontejnery a vytvoří seznam
  const psOut = sh('docker ps --format "{{.Names}}|{{.Image}}|{{.Status}}|{{.State}}"');
  if (!psOut) return { running: 0, total: 0, containers: [] };
  const containers = psOut.split('\n').filter(Boolean).map(line => {
    const [name, image, status, state] = line.split('|');
    return { name, image, status, state, healthy: !status.toLowerCase().includes('unhealthy') };
  });
  const allOut = sh('docker ps -a --format "{{.Names}}"');
  const total = allOut ? allOut.split('\n').filter(Boolean).length : containers.length;
  return {
    running: containers.length,
    total,
    containers,
  };
}

function collectSslCerts() {
  // Najde Let's Encrypt certifikáty a zjistí dny do expirace
  const liveDir = '/etc/letsencrypt/live';
  if (!existsSync(liveDir)) return [];
  const domains = sh(`ls ${liveDir} 2>/dev/null`).split('\n').filter(d => d && d !== 'README');
  return domains.map(domain => {
    const certPath = `${liveDir}/${domain}/cert.pem`;
    const expiry = sh(`openssl x509 -enddate -noout -in ${certPath} 2>/dev/null | cut -d= -f2`);
    if (!expiry) return { domain, error: 'unreadable' };
    const expiryDate = new Date(expiry);
    const daysLeft = Math.floor((expiryDate - Date.now()) / 86400000);
    return { domain, expires: expiryDate.toISOString(), days_left: daysLeft };
  });
}

function collectBackups() {
  // Hledá poslední tar v /var/backups/postgres/
  const dir = '/var/backups/postgres';
  if (!existsSync(dir)) return null;
  const latest = sh(`ls -t ${dir}/*.tar.gz 2>/dev/null | head -1`);
  if (!latest) return null;
  const stat = sh(`stat -c '%Y|%s' "${latest}" 2>/dev/null`);
  if (!stat) return null;
  const [mtime, size] = stat.split('|');
  return {
    file: path.basename(latest),
    age_hours: Math.round((Date.now() / 1000 - parseInt(mtime, 10)) / 3600),
    size_mb: Math.round(parseInt(size, 10) / 1024 / 1024),
  };
}

// === MAIN ===

function collect() {
  return {
    collected_at: new Date().toISOString(),
    hostname: sh('hostname') || 'unknown',
    public_ip: sh('curl -s -4 --max-time 5 ifconfig.me') || null,
    os: sh('cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2 | tr -d \\"') || null,
    kernel: sh('uname -r'),
    uptime: collectUptime(),
    memory: collectMemory(),
    cpu: collectCpu(),
    disk: collectDisk(),
    postgres: collectPostgres(),
    docker: collectDocker(),
    ssl_certs: collectSslCerts(),
    last_backup: collectBackups(),
  };
}

function writeLatest(data) {
  const file = path.join(STATS_DIR, 'latest.json');
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  console.log(`Wrote ${file}`);
}

function appendHistory(data) {
  const dbPath = path.join(STATS_DIR, 'history.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      collected_at TEXT PRIMARY KEY,
      ram_used_mb INTEGER, ram_total_mb INTEGER,
      cpu_load_1m REAL, cpu_load_pct REAL,
      disk_used_gb REAL, disk_total_gb REAL,
      db_total_mb INTEGER,
      docker_running INTEGER, docker_total INTEGER
    );
  `);
  db.prepare(`
    INSERT OR REPLACE INTO history (
      collected_at, ram_used_mb, ram_total_mb, cpu_load_1m, cpu_load_pct,
      disk_used_gb, disk_total_gb, db_total_mb, docker_running, docker_total
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.collected_at,
    data.memory?.used_mb || 0, data.memory?.total_mb || 0,
    data.cpu?.load_1m || 0, data.cpu?.load_pct_1m || 0,
    data.disk?.used_gb || 0, data.disk?.total_gb || 0,
    data.postgres?.total_mb || 0,
    data.docker?.running || 0, data.docker?.total || 0,
  );
  // Smaž data starší než 90 dní
  db.prepare(`DELETE FROM history WHERE collected_at < datetime('now', '-90 days')`).run();
  db.close();
}

const data = collect();
writeLatest(data);
appendHistory(data);
console.log('Collector finished:', new Date().toISOString());
