// Servírování příloh dokladů. /media/ je veřejné (profilové fotky), účtenky
// a faktury ale patří jen přihlášeným — proto vlastní chráněná cesta.

import path from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { MEDIA_DIR, mimeForFile } from '../attachments.js';

export default async function documentsRoutes(fastify) {
  fastify.get('/doklady/soubor/:filename', async (request, reply) => {
    if (!request.user) return reply.code(401).send('Unauthorized');

    const name = path.basename(request.params.filename || '');
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return reply.code(400).send('Neplatný název souboru.');

    const full = path.join(MEDIA_DIR, name);
    if (!existsSync(full)) return reply.code(404).send('Soubor nenalezen.');

    // ?download=1 pro stažení, jinak náhled přímo v prohlížeči
    const disposition = request.query.download === '1' ? 'attachment' : 'inline';
    reply.header('Content-Type', mimeForFile(name));
    reply.header('Content-Length', statSync(full).size);
    reply.header('Content-Disposition', `${disposition}; filename="${name}"`);
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(createReadStream(full));
  });
}
