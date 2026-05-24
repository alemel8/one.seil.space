import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHistoryDb } from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');
const STATS_DIR = process.env.STATS_DIR || path.join(projectRoot, 'data');
const TZ = process.env.TZ || 'Europe/Prague';

function readLatest() {
  const file = path.join(STATS_DIR, 'latest.json');
  if (!existsSync(file)) {
    return { error: 'Žádná data – collector ještě neběžel.', stale: true };
  }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const ageMs = Date.now() - new Date(data.collected_at).getTime();
    data.age_minutes = Math.floor(ageMs / 60000);
    data.stale = ageMs > 2 * 60 * 60 * 1000;
    return data;
  } catch (e) {
    return { error: `Chyba čtení: ${e.message}`, stale: true };
  }
}

function readHistory(hours = 72) {
  const db = getHistoryDb();
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT collected_at, ram_used_mb, ram_total_mb, cpu_load_1m,
             disk_used_gb, disk_total_gb, db_total_mb,
             docker_running, docker_total
      FROM history
      WHERE collected_at >= datetime('now', '-' || ? || ' hours')
      ORDER BY collected_at ASC
    `).all(hours);
  } catch {
    return [];
  }
}

export default async function dashboardRoutes(fastify) {

  fastify.get('/', async (request, reply) => {
    const latest = readLatest();
    const history = readHistory(72);
    const chartScript = history.length > 0 ? `
<script src="/static/chart.umd.min.js"></script>
<script>
const history = ${JSON.stringify(history)};
const labels = history.map(h => new Date(h.collected_at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }));
const mkChart = (id, label, data, color, max) => {
  const el = document.getElementById(id);
  if (!el) return;
  new Chart(el, {
    type: 'line',
    data: { labels, datasets: [{ label, data, borderColor: color, backgroundColor: color + '20', fill: true, tension: 0.3, pointRadius: 2 }] },
    options: { responsive: true, plugins: { legend: { position: 'top' } }, scales: { y: max ? { max, beginAtZero: true } : { beginAtZero: true } } }
  });
};
mkChart('chart-ram', 'RAM použito (MB)', history.map(h => h.ram_used_mb), '#4F46E5');
mkChart('chart-disk', 'Disk použito (GB)', history.map(h => h.disk_used_gb), '#10b981');
mkChart('chart-cpu', 'CPU load (%)', history.map(h => h.cpu_load_1m), '#f59e0b', 100);
</script>` : '';

    return reply.view('pages/dashboard.ejs', {
      pageTitle: 'Aktuální stav VPS',
      currentPath: '/',
      user: request.user,
      latest,
      history,
      now: new Date(),
      timezone: TZ,
      extraJs: chartScript,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.get('/api/latest', async () => readLatest());

  fastify.get('/api/history', async (request) => {
    const hours = Math.min(parseInt(request.query.hours || '24', 10), 720);
    return readHistory(hours);
  });
}
