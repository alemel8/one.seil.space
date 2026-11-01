export default async function userSettingsRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user) return reply.redirect('/prihlasit');
  });

  // Osobní nastavení je záložka profilu, stará adresa zůstává kvůli záložkám v prohlížeči.
  fastify.get('/nastaveni', async (request, reply) => reply.redirect('/profil?tab=notifikace'));
}
