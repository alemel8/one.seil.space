// Web server pro VPS monitoring dashboard.
// Čte data, která sbírá collector (běží mimo tento proces, jako cron na hostu).
// Data leží v STATS_DIR jako latest.json a history.sqlite.

import Fastify from 'fastify';
import basicAuth from '@fastify/basic-auth';
import view from '@fastify/view';
import staticPlugin from '@fastify/static';
import ejs from 'ejs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const STATS_DIR = process.env.STATS_DIR || path.join(projectRoot, 'data');
const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

if (!DASHBOARD_PASSWORD) {
  console.error('FATAL: DASHBOARD_PASSWORD env variable not set.');
  process.exit(1);
}

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
  },
});

// Basic auth
await fastify.register(basicAuth, {
  validate: async (username, password) => {
    if (username !== DASHBOARD_USER || password !== DASHBOARD_PASSWORD) {
      throw new Error('Invalid credentials');
    }
  },
  authenticate: { realm: 'one.seil.space' },
});

// EJS šablony
await fastify.register(view, {
  engine: { ejs },
  root: path.join(projectRoot, 'views'),
  defaultContext: { appName: 'one.seil.space' },
});

// Static assets (Chart.js etc.)
await fastify.register(staticPlugin, {
  root: path.join(projectRoot, 'public'),
  prefix: '/static/',
});

// === ROUTES ===

// Healthcheck (BEZ auth, pro Docker healthcheck a Coolify)
fastify.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

// Vše ostatní za auth
fastify.after(() => {
  fastify.addHook('onRequest', fastify.basicAuth);

  fastify.get('/', async (request, reply) => {
    const latest = readLatest();
    const history = readHistory(72); // posledních 72 hodin
    return reply.view('dashboard.ejs', {
      latest,
      history,
      now: new Date(),
      timezone: process.env.TZ || 'UTC',
    });
  });

  fastify.get('/api/latest', async () => readLatest());
  fastify.get('/api/history', async (request) => {
    const hours = Math.min(parseInt(request.query.hours || '24', 10), 720); // max 30 dni
    return readHistory(hours);
  });
});

// === DATA ACCESS ===

function readLatest() {
  const file = path.join(STATS_DIR, 'latest.json');
  if (!existsSync(file)) {
    return { error: 'Žádná data – collector ještě neběžel.', stale: true };
  }
  try {
    const raw = readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    const ageMs = Date.now() - new Date(data.collected_at).getTime();
    data.age_minutes = Math.floor(ageMs / 60000);
    data.stale = ageMs > 2 * 60 * 60 * 1000; // > 2 h = stale
    return data;
  } catch (e) {
    return { error: `Chyba čtení: ${e.message}`, stale: true };
  }
}

let _db = null;
function getDb() {
  if (_db) return _db;
  const dbPath = path.join(STATS_DIR, 'history.sqlite');
  if (!existsSync(dbPath)) return null;
  _db = new Database(dbPath, { readonly: true });
  return _db;
}

function readHistory(hours = 24) {
  const db = getDb();
  if (!db) return [];
  try {
    const stmt = db.prepare(`
      SELECT collected_at, ram_used_mb, ram_total_mb, cpu_load_1m,
             disk_used_gb, disk_total_gb, db_total_mb,
             docker_running, docker_total
      FROM history
      WHERE collected_at >= datetime('now', '-' || ? || ' hours')
      ORDER BY collected_at ASC
    `);
    return stmt.all(hours);
  } catch (e) {
    fastify.log.warn({ err: e.message }, 'history read failed');
    return [];
  }
}

// === START ===

try {
  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(`one.seil.space listening on http://${HOST}:${PORT}`);
  fastify.log.info(`Reading stats from ${STATS_DIR}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

// Graceful shutdown
const shutdown = async (signal) => {
  fastify.log.info(`Received ${signal}, shutting down`);
  if (_db) _db.close();
  await fastify.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
