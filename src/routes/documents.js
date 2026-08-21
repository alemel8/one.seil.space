// Servírování příloh dokladů. Adresář data/media je od migrace na neveřejnou
// cestu dosažitelný jen přihlášeným, přesto tu zůstávají dvě různé routy:
//
//   /doklady/soubor/:filename  — účtenky a faktury, stačí být přihlášen
//   /doklady/priloha/:id       — personální přílohy, kontroluje se vlastník
//
// Rozdíl je záměrný. U účtenky je jedno, který z týmu si ji otevře. U výplatní
// pásky ne — a název souboru o vlastníkovi nic neříká, takže se musí rozhodovat
// podle záznamu v databázi.

import path from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { MEDIA_DIR, mimeForFile } from '../attachments.js';
import { getDb } from '../db.js';

// Co prohlížeč umí bezpečně ukázat. Zbytek se nabídne ke stažení — XML ani
// ZIP nemá smysl otevírat inline a u HTML/SVG by to byl zbytečný risk.
const NAHLED_MIME = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif',
]);

function posliSoubor(reply, { full, name, mime, download }) {
  const inline = !download && NAHLED_MIME.has(mime);
  reply.header('Content-Type', mime);
  reply.header('Content-Length', statSync(full).size);
  reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name}"`);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Cache-Control', 'private, max-age=3600');
  return reply.send(createReadStream(full));
}

export default async function documentsRoutes(fastify) {
  const sql = getDb();

  fastify.get('/doklady/soubor/:filename', async (request, reply) => {
    if (!request.user) return reply.code(401).send('Unauthorized');

    const name = path.basename(request.params.filename || '');
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return reply.code(400).send('Neplatný název souboru.');

    const full = path.join(MEDIA_DIR, name);
    if (!existsSync(full)) return reply.code(404).send('Soubor nenalezen.');

    return posliSoubor(reply, {
      full, name, mime: mimeForFile(name), download: request.query.download === '1',
    });
  });

  // Personální přílohy — mzdy, osobní dokumenty, fakturační podklady.
  // Kdo není správce, dostane jen svoje.
  fastify.get('/doklady/priloha/:id', async (request, reply) => {
    if (!request.user) return reply.code(401).send('Unauthorized');
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send('Neplatné ID přílohy.');

    const [row] = await sql`
      SELECT a.path, a.mime, a.original_name, a.task_id,
             COALESCE(wr.user_id, pr.user_id, pi.user_id, d.user_id) AS owner_id
        FROM attachments a
        LEFT JOIN hr_work_reports  wr ON wr.id = a.work_report_id
        LEFT JOIN hr_payroll_runs  pr ON pr.id = a.payroll_run_id
        LEFT JOIN hr_payroll_items pi ON pi.id = a.payroll_item_id
        LEFT JOIN hr_documents     d  ON d.id  = a.document_id
       WHERE a.id = ${id}
    `;
    if (!row) return reply.code(404).send('Příloha nenalezena.');

    // Přílohy úkolů jsou pracovní materiál, ty vidí každý přihlášený.
    // Cokoliv navázaného na člověka je osobní údaj.
    const osobni = row.owner_id !== null;
    if (osobni && !request.user.is_admin && request.user.id !== row.owner_id) {
      request.log.info({ prilohaId: id, userId: request.user.id }, 'pokus o cizí osobní přílohu');
      return reply.code(403).send('K této příloze nemáte přístup.');
    }

    const name = path.basename(String(row.path));
    const full = path.join(MEDIA_DIR, name);
    if (!existsSync(full)) return reply.code(404).send('Soubor nenalezen.');

    return posliSoubor(reply, {
      full,
      // Ke stažení pod původním názvem — „Výplatnice_mezd 06.pdf" řekne víc
      // než „paska_1755640000000.pdf".
      name: (row.original_name || name).replace(/["\\\r\n]/g, ''),
      mime: row.mime || mimeForFile(name),
      download: request.query.download === '1',
    });
  });
}
