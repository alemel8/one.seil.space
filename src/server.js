import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import formbody from '@fastify/formbody';
import view from '@fastify/view';
import staticPlugin from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import ejs from 'ejs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeAll } from './db.js';
import { runMigrations } from './migrate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_SECRET = process.env.SESSION_SECRET || 'one-seil-space-secret-change-in-production-32chars';

if (SESSION_SECRET.length < 32) {
  console.warn('WARN: SESSION_SECRET by měl mít alespoň 32 znaků.');
}

// ── Databáze + migrace ────────────────────────────────────────

const sql = getDb();
await runMigrations(sql);

// ── Fastify ───────────────────────────────────────────────────

const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

await fastify.register(formbody);
await fastify.register(cookie);
await fastify.register(fastifySession, {
  secret: SESSION_SECRET,
  cookie: {
    secure: process.env.COOKIE_SECURE === 'true',
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000,
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

await fastify.register(swagger, {
  openapi: {
    openapi: '3.0.0',
    info: {
      title: 'one.seil.space API',
      description: 'Multi-eshop API pro příjem objednávek a správu zákazníků v CRM.',
      version: '1.0.0',
    },
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
      },
    },
    tags: [
      { name: 'Objednávky', description: 'Příjem a správa objednávek z eshopů' },
      { name: 'Zákazníci',  description: 'Registrace a správa zákazníků v CRM' },
    ],
  },
});

await fastify.register(swaggerUi, {
  routePrefix: '/api/docs',
  uiConfig: { docExpansion: 'list', deepLinking: true },
  staticCSP: true,
});

// ── Auth hook ─────────────────────────────────────────────────

fastify.addHook('preHandler', async (request) => {
  request.user = null;
  if (request.session.userId) {
    const rows = await sql`
      SELECT id, email, first_name, last_name, is_admin, is_active, photo
      FROM users WHERE id = ${request.session.userId} AND is_active = TRUE
    `;
    request.user = rows[0] ?? null;
    if (!request.user) await request.session.destroy();
  }
});

// ── Healthcheck ───────────────────────────────────────────────

fastify.get('/health',     async () => ({ ok: true, ts: new Date().toISOString() }));
fastify.get('/health/api', async () => ({ ok: true, ts: new Date().toISOString() }));

// ── Auth routes (veřejné) ─────────────────────────────────────

const { default: authRoutes } = await import('./routes/auth.js');
await fastify.register(authRoutes);

// ── Auth guard ────────────────────────────────────────────────

fastify.addHook('onRequest', async (request, reply) => {
  const publicPaths = ['/prihlasit', '/health', '/static', '/health/api', '/api/toneracek', '/api/v1', '/api/docs'];
  const isPublic = publicPaths.some(
    p => request.url === p || request.url.startsWith(p + '/') || request.url.startsWith(p + '?')
  );
  if (!isPublic && !request.session.userId) {
    return reply.redirect('/prihlasit');
  }
});

// ── Routes ────────────────────────────────────────────────────

const { default: apiRoutes }        = await import('./routes/api.js');
const { default: dashboardRoutes }  = await import('./routes/dashboard.js');
const { default: crmRoutes }        = await import('./routes/crm.js');
const { default: peopleRoutes }     = await import('./routes/people.js');
const { default: accountingRoutes } = await import('./routes/accounting.js');
const { default: invoicesRoutes }   = await import('./routes/invoices.js');
const { default: toneracekRoutes }  = await import('./routes/toneracek.js');
const { default: settingsRoutes }   = await import('./routes/settings.js');

await fastify.register(apiRoutes);
await fastify.register(dashboardRoutes);
await fastify.register(crmRoutes);
await fastify.register(peopleRoutes);
await fastify.register(accountingRoutes);
await fastify.register(invoicesRoutes);
await fastify.register(toneracekRoutes);
await fastify.register(settingsRoutes);

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
  await closeAll();
  await fastify.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
