import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import formbody from '@fastify/formbody';
import view from '@fastify/view';
import staticPlugin from '@fastify/static';
import ejs from 'ejs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAppDb, closeAll } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_SECRET = process.env.SESSION_SECRET || 'one-seil-space-secret-change-in-production-32chars';

if (SESSION_SECRET.length < 32) {
  console.warn('WARN: SESSION_SECRET by měl mít alespoň 32 znaků pro bezpečnost.');
}

const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

// ── Plugins ───────────────────────────────────────────────────

await fastify.register(formbody);
await fastify.register(cookie);
await fastify.register(session, {
  secret: SESSION_SECRET,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000, // 8 hodin
    sameSite: 'lax',
  },
  saveUninitialized: false,
});

await fastify.register(view, {
  engine: { ejs },
  root: path.join(projectRoot, 'views'),
  layout: false,
  defaultContext: { appName: 'one.seil.space' },
  options: { views: path.join(projectRoot, 'views') },
});

await fastify.register(staticPlugin, {
  root: path.join(projectRoot, 'public'),
  prefix: '/static/',
});

// ── Auth hook: přidá request.user ke každému requestu ─────────

fastify.addHook('preHandler', async (request) => {
  request.user = null;
  if (request.session.userId) {
    const db = getAppDb();
    const user = db.prepare(
      'SELECT id, email, first_name, last_name, is_admin, is_active, photo FROM users WHERE id = ? AND is_active = 1'
    ).get(request.session.userId);
    request.user = user || null;
    if (!user) await request.session.destroy();
  }
});

// ── Healthcheck (bez auth) ────────────────────────────────────

fastify.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

// ── Auth routes (bez ochrany) ─────────────────────────────────

const { default: authRoutes } = await import('./routes/auth.js');
await fastify.register(authRoutes);

// ── Auth guard pro všechny ostatní routy ─────────────────────

fastify.addHook('onRequest', async (request, reply) => {
  const publicPaths = ['/prihlasit', '/health', '/static'];
  const isPublic = publicPaths.some(p => request.url === p || request.url.startsWith(p + '/') || request.url.startsWith(p + '?'));
  if (!isPublic && !request.session.userId) {
    return reply.redirect('/prihlasit');
  }
});

// ── Protected routes ──────────────────────────────────────────

const { default: dashboardRoutes } = await import('./routes/dashboard.js');
const { default: crmRoutes } = await import('./routes/crm.js');
const { default: peopleRoutes } = await import('./routes/people.js');
const { default: accountingRoutes } = await import('./routes/accounting.js');

await fastify.register(dashboardRoutes);
await fastify.register(crmRoutes);
await fastify.register(peopleRoutes);
await fastify.register(accountingRoutes);

// ── Start ─────────────────────────────────────────────────────

try {
  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(`one.seil.space běží na http://${HOST}:${PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

// ── Graceful shutdown ─────────────────────────────────────────

const shutdown = async (signal) => {
  fastify.log.info(`Přijat ${signal}, vypínám…`);
  closeAll();
  await fastify.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
