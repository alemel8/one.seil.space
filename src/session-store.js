// PostgreSQL session store pro @fastify/session
// Používá existující tabulku `session` (vytvořena v migration 001)
// a stávající postgres.js klienta — žádná extra závislost.

export class PgSessionStore {
  constructor(sql) {
    this.sql = sql;
    this._scheduleCleanup();
  }

  get(sessionId, callback) {
    this.sql`
      SELECT sess FROM session
      WHERE sid = ${sessionId} AND expire > NOW()
    `.then(([row]) => {
      callback(null, row ? row.sess : null);
    }).catch(err => callback(err));
  }

  set(sessionId, session, callback) {
    const maxAge = session?.cookie?.maxAge ?? (8 * 60 * 60 * 1000);
    const expire = new Date(Date.now() + maxAge);
    const sess   = JSON.parse(JSON.stringify(session)); // strip non-serializable values

    this.sql`
      INSERT INTO session (sid, sess, expire)
      VALUES (${sessionId}, ${sess}, ${expire})
      ON CONFLICT (sid) DO UPDATE
        SET sess = EXCLUDED.sess, expire = EXCLUDED.expire
    `.then(() => callback(null))
     .catch(err => callback(err));
  }

  destroy(sessionId, callback) {
    this.sql`DELETE FROM session WHERE sid = ${sessionId}`
      .then(() => callback(null))
      .catch(err => callback(err));
  }

  touch(sessionId, session, callback) {
    const maxAge = session?.cookie?.maxAge ?? (8 * 60 * 60 * 1000);
    const expire = new Date(Date.now() + maxAge);
    this.sql`UPDATE session SET expire = ${expire} WHERE sid = ${sessionId}`
      .then(() => callback(null))
      .catch(err => callback(err));
  }

  // Každých 24 hodin smaž expirované sessions
  _scheduleCleanup() {
    const run = () => {
      this.sql`DELETE FROM session WHERE expire < NOW()`
        .catch(err => console.warn('[session-store] cleanup error:', err.message));
      setTimeout(run, 24 * 60 * 60 * 1000);
    };
    setTimeout(run, 60 * 1000); // první cleanup minutu po startu
  }
}
