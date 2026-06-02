import { getDb, closeAll } from '../src/db.js';
import bcryptjs from 'bcryptjs';

const email     = process.argv[2] || 'ales@seil.cz';
const password  = process.argv[3] || '12345678';
const firstName = process.argv[4] || 'Aleš';
const lastName  = process.argv[5] || '';

const sql = getDb();
const hash = bcryptjs.hashSync(password, 10);

try {
  const [existing] = await sql`SELECT id FROM users WHERE LOWER(email) = ${email.toLowerCase()} LIMIT 1`;
  if (existing) {
    await sql`UPDATE users SET password_hash = ${hash}, is_admin = TRUE, is_active = TRUE WHERE id = ${existing.id}`;
    console.log(`✓ Uživatel ${email} aktualizován jako správce.`);
  } else {
    await sql`
      INSERT INTO users (email, password_hash, first_name, last_name, is_admin, is_active)
      VALUES (${email.toLowerCase()}, ${hash}, ${firstName}, ${lastName}, TRUE, TRUE)
    `;
    console.log(`✓ Superuživatel ${email} vytvořen.`);
  }
} catch (err) {
  console.error('❌ Chyba:', err.message);
} finally {
  await closeAll();
}
