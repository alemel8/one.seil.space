// Trade SEIL — minimální routa pro přehled paper tradingu.
//
// Zatím jen servíruje vygenerovaný dashboard za One SEIL přihlášením.
// Plnohodnotný modul (vlastní DB, worker, kill-switch) až podle
// Trade_SEIL_Integracni_plan_v1.md — teď by to bylo stavění platformy
// před důkazem edge, což návrh v1.1 zakazuje (past 13.1).
//
// Dashboard generuje research/build_dashboard.py; sem se jen kopíruje
// výsledný soubor. Cesta se dá přebít proměnnou TRADE_DASHBOARD.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

const DASHBOARD = process.env.TRADE_DASHBOARD
  || path.join(projectRoot, 'data', 'trade', 'dashboard.html');

export default async function tradeRoutes(fastify) {
  fastify.get('/trade', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');

    try {
      const [html, info] = await Promise.all([
        readFile(DASHBOARD, 'utf8'),
        stat(DASHBOARD),
      ]);
      const ageH = (Date.now() - info.mtimeMs) / 3_600_000;
      // Stavový model dat (Návrh v1.1, 8.5): stará data se musí přiznat,
      // ne tiše zobrazit. Bez tohohle nepozná uživatel, že kouká na včerejšek.
      const banner = ageH > 30 ? `
        <div style="position:fixed;top:0;left:0;right:0;z-index:99;
             background:#F59E0B;color:#0A1626;font:600 13px/1.4 system-ui;
             padding:8px 16px;text-align:center;">
          Data jsou stará ${Math.floor(ageH)} h — denní krok pravděpodobně neproběhl.
        </div><div style="height:34px"></div>` : '';
      return reply.type('text/html; charset=utf-8').send(banner + html);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return reply.code(503).type('text/html; charset=utf-8').send(`
          <div style="font:15px/1.6 system-ui;max-width:640px;margin:80px auto;padding:0 24px">
            <h1 style="font-size:20px">Přehled zatím není vygenerovaný</h1>
            <p>Očekávaný soubor: <code>${DASHBOARD}</code></p>
            <p>Vytvoří ho <code>python3 research/build_dashboard.py</code>.</p>
          </div>`);
      }
      throw err;
    }
  });
}
