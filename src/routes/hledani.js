// Globální hledání: stránka výsledků pro pole v horní liště. Logika
// (skupiny, dotazy, práva) je v src/hledani.js. Routa není v katalogu
// přístupové matice — vidí ji každý přihlášený a obsah filtruje hledej()
// po skupinách; do publicPaths v server.js nepatří, session guard ji chrání.

import { getDb } from '../db.js';
import { hledej, normalizujDotaz, povoleneSkupiny, MIN_DELKA } from '../hledani.js';

export default async function hledaniRoutes(fastify) {
  const sql = getDb();

  fastify.get('/hledat', async (request, reply) => {
    const q = normalizujDotaz(request.query.q);
    const skupiny = await hledej(sql, request.user, q, { limitNaSkupinu: 10 });
    const celkem = skupiny.reduce((n, g) => n + g.polozky.length, 0);
    // Výsledky nesou e-maily a jména — do cache prohlížeče nepatří.
    reply.header('Cache-Control', 'no-store');
    return reply.view('pages/hledani.ejs', {
      pageTitle: 'Hledání', currentPath: '/hledat', user: request.user,
      q, hledaniQ: q, skupiny, celkem,
      prilisKratke: q.length > 0 && q.length < MIN_DELKA, MIN_DELKA,
      oblasti: povoleneSkupiny(request.user).map((s) => ({ nazev: s.nazev, odkaz: s.odkazSeznam(q, []) })),
    }, { layout: 'layouts/base.ejs' });
  });
}
