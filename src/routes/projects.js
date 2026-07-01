import { getDb, generateId } from '../db.js';

// Typy podprojektů — jediné místo pravdy pro label/ikonu/barvu, sdílené routami i views.
export const PROJECT_TYPES = {
  web:             { label: 'Web',                      icon: 'web.svg',             color: '#14E6E6' },
  eshop:           { label: 'Eshop',                     icon: 'eshop.svg',           color: '#0F7E89' },
  erp:             { label: 'ERP',                       icon: 'erp.svg',             color: '#3B82F6' },
  konzultace:      { label: 'Konzultace',                icon: 'konzultace.svg',      color: '#22C55E' },
  mobilni:         { label: 'Mobilní aplikace',          icon: 'mobilni.svg',         color: '#8A93A3' },
  design:          { label: 'Design',                    icon: 'design.svg',          color: '#EC4899' },
  marketing:       { label: 'Marketing & kampaně',       icon: 'marketing.svg',       color: '#F59E0B' },
  podpora:         { label: 'Podpora & údržba',          icon: 'podpora.svg',         color: '#EF4444' },
  integrace:       { label: 'Integrace & automatizace',  icon: 'integrace.svg',       color: '#6D28D9' },
  infrastruktura:  { label: 'Infrastruktura & hosting',  icon: 'infrastruktura.svg',  color: '#0A1626' },
};

const PROJECT_STATUSES = ['Aktivní', 'Pozastaveno', 'Dokončeno', 'Archivováno'];
const ITEM_STATUSES    = ['V přípravě', 'Aktivní', 'Pozastaveno', 'Dokončeno'];

export default async function projectsRoutes(fastify) {
  const sql = getDb();

  // ── Seznam projektů ────────────────────────────────────────────

  fastify.get('/projekty', async (request, reply) => {
    const q            = (request.query.q      || '').trim();
    const statusFilter  = (request.query.status || '').trim();

    const conditions = [];
    if (q)            conditions.push(sql`(p.name ILIKE ${'%' + q + '%'} OR c.name ILIKE ${'%' + q + '%'})`);
    if (statusFilter) conditions.push(sql`p.status = ${statusFilter}`);
    const where = conditions.length
      ? sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`
      : sql``;

    const projects = await sql`
      SELECT p.*, c.name AS company_name,
             (SELECT COUNT(*)::int FROM project_items pi WHERE pi.project_id = p.id) AS item_count,
             (SELECT array_agg(DISTINCT pi.type) FROM project_items pi WHERE pi.project_id = p.id) AS item_types
      FROM projects p
      JOIN crm_companies c ON c.id = p.company_id
      ${where}
      ORDER BY p.modified_at DESC
    `;
    const companies = await sql`SELECT id, name FROM crm_companies ORDER BY name`;

    return reply.view('pages/projects/list.ejs', {
      pageTitle: 'Projekty', currentPath: '/projekty', user: request.user,
      projects, companies, q, statusFilter,
      PROJECT_TYPES, PROJECT_STATUSES,
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/projekty/vytvorit', async (request, reply) => {
    const b = request.body || {};
    if (!b.company_id) return reply.redirect('/projekty');

    const [company] = await sql`SELECT name FROM crm_companies WHERE id = ${b.company_id}`;
    if (!company) return reply.redirect('/projekty');

    const id = generateId();
    await sql`
      INSERT INTO projects (id, company_id, name, status, start_date, created_by, modified_by)
      VALUES (${id}, ${b.company_id}, ${(b.name || '').trim() || company.name}, ${b.status || 'Aktivní'},
              ${b.start_date || null}, ${request.user?.id || null}, ${request.user?.id || null})
    `;
    return reply.redirect(`/projekty/${id}`);
  });

  // ── Detail projektu ─────────────────────────────────────────────

  fastify.get('/projekty/:id', async (request, reply) => {
    const [project] = await sql`
      SELECT p.*, c.name AS company_name
      FROM projects p JOIN crm_companies c ON c.id = p.company_id
      WHERE p.id = ${request.params.id}
    `;
    if (!project) return reply.code(404).send('Projekt nenalezen');

    const [contacts, items, healthchecks, shops] = await Promise.all([
      sql`SELECT id, first_name, last_name FROM crm_contacts WHERE company_id = ${project.company_id} ORDER BY last_name, first_name`,
      sql`SELECT * FROM project_items WHERE project_id = ${project.id} ORDER BY created_at DESC`,
      sql`SELECT id, name FROM healthchecks ORDER BY name`,
      sql`SELECT id, name FROM shops ORDER BY name`,
    ]);

    return reply.view('pages/projects/detail.ejs', {
      pageTitle: project.name, currentPath: '/projekty', user: request.user,
      project, contacts, items, healthchecks, shops,
      PROJECT_TYPES, PROJECT_STATUSES, ITEM_STATUSES,
      tab: request.query.tab || 'prehled',
      saved: request.query.saved === '1',
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/projekty/:id', async (request, reply) => {
    const b = request.body || {};
    await sql`
      UPDATE projects SET
        name                        = ${(b.name || '').trim()},
        status                      = ${b.status || 'Aktivní'},
        primary_contact_id          = ${b.primary_contact_id || null},
        start_date                  = ${b.start_date || null},
        brand_primary_color         = ${(b.brand_primary_color   || '').trim()},
        brand_secondary_color       = ${(b.brand_secondary_color || '').trim()},
        brand_fonts                 = ${(b.brand_fonts           || '').trim()},
        brand_assets_url            = ${(b.brand_assets_url      || '').trim()},
        brand_notes                 = ${(b.brand_notes           || '').trim()},
        billing_payment_terms_days  = ${b.billing_payment_terms_days ? parseInt(b.billing_payment_terms_days, 10) : null},
        billing_currency            = ${b.billing_currency || 'CZK'},
        billing_hourly_rate         = ${b.billing_hourly_rate ? parseFloat(b.billing_hourly_rate) : null},
        billing_notes               = ${(b.billing_notes || '').trim()},
        notes                       = ${(b.notes || '').trim()},
        modified_by                 = ${request.user?.id || null},
        modified_at                 = NOW()
      WHERE id = ${request.params.id}
    `;
    return reply.redirect(`/projekty/${request.params.id}?tab=${b.tab || 'prehled'}&saved=1`);
  });

  fastify.post('/projekty/:id/smazat', async (request, reply) => {
    await sql`DELETE FROM projects WHERE id = ${request.params.id}`;
    return reply.redirect('/projekty');
  });

  // ── Podprojekty ──────────────────────────────────────────────

  fastify.post('/projekty/:id/podprojekty/vytvorit', async (request, reply) => {
    const b = request.body || {};
    if (!b.type || !PROJECT_TYPES[b.type]) return reply.redirect(`/projekty/${request.params.id}?tab=podprojekty`);

    const id = generateId();
    await sql`
      INSERT INTO project_items (id, project_id, type, name, status, description, hosting_provider,
                                  production_url, staging_url, repo_url, tech_stack,
                                  shop_id, healthcheck_id, go_live_date, notes, created_by, modified_by)
      VALUES (${id}, ${request.params.id}, ${b.type}, ${(b.name || '').trim() || PROJECT_TYPES[b.type].label},
              ${b.status || 'V přípravě'}, ${(b.description || '').trim()}, ${(b.hosting_provider || '').trim()},
              ${(b.production_url || '').trim()}, ${(b.staging_url || '').trim()}, ${(b.repo_url || '').trim()},
              ${(b.tech_stack || '').trim()},
              ${b.shop_id || null}, ${b.healthcheck_id ? parseInt(b.healthcheck_id, 10) : null},
              ${b.go_live_date || null}, ${(b.notes || '').trim()},
              ${request.user?.id || null}, ${request.user?.id || null})
    `;
    return reply.redirect(`/projekty/podprojekty/${id}`);
  });

  fastify.get('/projekty/podprojekty/:id', async (request, reply) => {
    const [item] = await sql`
      SELECT pi.*, p.name AS project_name, p.company_id, c.name AS company_name
      FROM project_items pi
      JOIN projects p ON p.id = pi.project_id
      JOIN crm_companies c ON c.id = p.company_id
      WHERE pi.id = ${request.params.id}
    `;
    if (!item) return reply.code(404).send('Podprojekt nenalezen');

    let health = null;
    if (item.healthcheck_id) {
      const [h] = await sql`
        SELECT h.id, h.name, h.url, h.active,
               r.ok, r.status_code, r.latency_ms, r.checked_at, r.error
        FROM healthchecks h
        LEFT JOIN LATERAL (
          SELECT ok, status_code, latency_ms, checked_at, error
          FROM healthcheck_results
          WHERE check_id = h.id
          ORDER BY checked_at DESC LIMIT 1
        ) r ON TRUE
        WHERE h.id = ${item.healthcheck_id}
      `;
      health = h || null;
    }

    let shop = null;
    if (item.shop_id) {
      const [s] = await sql`SELECT id, name, url, active FROM shops WHERE id = ${item.shop_id}`;
      shop = s || null;
    }

    const [healthchecks, shops] = await Promise.all([
      sql`SELECT id, name FROM healthchecks ORDER BY name`,
      sql`SELECT id, name FROM shops ORDER BY name`,
    ]);

    return reply.view('pages/projects/item-detail.ejs', {
      pageTitle: item.name, currentPath: '/projekty', user: request.user,
      item, health, shop, healthchecks, shops,
      PROJECT_TYPES, ITEM_STATUSES,
      saved: request.query.saved === '1',
    }, { layout: 'layouts/base.ejs' });
  });

  fastify.post('/projekty/podprojekty/:id', async (request, reply) => {
    const b = request.body || {};
    await sql`
      UPDATE project_items SET
        name              = ${(b.name || '').trim()},
        status            = ${b.status || 'V přípravě'},
        description       = ${(b.description || '').trim()},
        hosting_provider  = ${(b.hosting_provider || '').trim()},
        production_url    = ${(b.production_url || '').trim()},
        staging_url       = ${(b.staging_url || '').trim()},
        repo_url          = ${(b.repo_url || '').trim()},
        tech_stack        = ${(b.tech_stack || '').trim()},
        shop_id           = ${b.shop_id || null},
        healthcheck_id    = ${b.healthcheck_id ? parseInt(b.healthcheck_id, 10) : null},
        go_live_date      = ${b.go_live_date || null},
        notes             = ${(b.notes || '').trim()},
        modified_by       = ${request.user?.id || null},
        modified_at       = NOW()
      WHERE id = ${request.params.id}
    `;
    return reply.redirect(`/projekty/podprojekty/${request.params.id}?saved=1`);
  });

  fastify.post('/projekty/podprojekty/:id/smazat', async (request, reply) => {
    const [i] = await sql`SELECT project_id FROM project_items WHERE id = ${request.params.id}`;
    await sql`DELETE FROM project_items WHERE id = ${request.params.id}`;
    return reply.redirect(i ? `/projekty/${i.project_id}?tab=podprojekty` : '/projekty');
  });
}
