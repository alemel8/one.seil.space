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
  const { getDb } = await import('../db.js');
  const sql = getDb();

  // ── Domovská stránka ─────────────────────────────────────────
  fastify.get('/', async (request, reply) => {
    const now = new Date();
    const mStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const mEnd   = new Date(now.getFullYear(), now.getMonth()+1, 0).toISOString().slice(0,10);

    const [issued]   = await sql`SELECT COALESCE(SUM(total_amount),0)::numeric AS v, COUNT(*)::int AS n FROM accounting_invoices WHERE type='issued'   AND issue_date BETWEEN ${mStart} AND ${mEnd}`;
    const [received] = await sql`SELECT COALESCE(SUM(total_amount),0)::numeric AS v, COUNT(*)::int AS n FROM accounting_invoices WHERE type='received' AND issue_date BETWEEN ${mStart} AND ${mEnd}`;
    const [overdueCount] = await sql`SELECT COUNT(*)::int AS n FROM accounting_invoices WHERE status='Po splatnosti'`;
    const [ordersWaiting] = await sql`SELECT COUNT(*)::int AS n FROM shop_orders WHERE status NOT IN ('dokoncena','zrusena','storno')`;
    const [crmFirmy]   = await sql`SELECT COUNT(*)::int AS n FROM crm_companies`;
    const [crmKontakty]= await sql`SELECT COUNT(*)::int AS n FROM crm_contacts`;
    const [crmNew]     = await sql`SELECT COUNT(*)::int AS n FROM crm_contacts WHERE created_at >= NOW() - INTERVAL '30 days'`;
    const [team]       = await sql`SELECT COUNT(*)::int AS n FROM users WHERE is_active=TRUE`;
    const [uctenky]    = await sql`SELECT COUNT(*)::int AS n, COALESCE(SUM(total_amount),0)::numeric AS v FROM receipts WHERE receipt_date BETWEEN ${mStart} AND ${mEnd}`;

    const latest = readLatest();
    const vpsOk = !latest.error && !latest.stale;

    return reply.view('pages/home.ejs', {
      pageTitle: 'Přehled', currentPath: '/',
      user: request.user,
      kpi: {
        issuedMonth: Number(issued.v), issuedCount: issued.n,
        receivedMonth: Number(received.v), receivedCount: received.n,
        overdue: overdueCount.n,
        ordersWaiting: ordersWaiting.n,
        firmy: crmFirmy.n, kontakty: crmKontakty.n, crmNew: crmNew.n,
        team: team.n,
        uctenkyCount: uctenky.n, uctenkyMonth: Number(uctenky.v),
      },
      vps: vpsOk ? { ram: latest.memory, cpu: latest.cpu, disk: latest.disk } : null,
    }, { layout: 'layouts/base.ejs' });
  });

  // ── VPS Monitoring (přesunuto z /) ───────────────────────────
  fastify.get('/monitoring', async (request, reply) => {
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
mkChart('chart-ram', 'RAM použito (MB)', history.map(h => h.ram_used_mb), 'var(--primary)');
mkChart('chart-disk', 'Disk použito (GB)', history.map(h => h.disk_used_gb), '#10b981');
mkChart('chart-cpu', 'CPU load (%)', history.map(h => h.cpu_load_1m), '#f59e0b', 100);
</script>` : '';

    return reply.view('pages/dashboard.ejs', {
      pageTitle: 'Aktuální stav VPS', currentPath: '/monitoring',
      user: request.user, latest, history, now, timezone: TZ,
      extraJs: chartScript,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.get('/api/latest', async () => readLatest());
  fastify.get('/api/history', async (request) => {
    const hours = Math.min(parseInt(request.query.hours || '24', 10), 720);
    return readHistory(hours);
  });
}
