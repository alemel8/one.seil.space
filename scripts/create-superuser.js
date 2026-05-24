import { getAppDb, closeAll } from '../src/db.js';
import bcryptjs from 'bcryptjs';

const email = process.argv[2] || 'ales@seil.cz';
const password = process.argv[3] || '12345678';
const firstName = process.argv[4] || 'Aleš';
const lastName = process.argv[5] || '';

const db = getAppDb();
const hash = bcryptjs.hashSync(password, 10);

try {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, is_admin = 1, is_active = 1 WHERE email = ?').run(hash, email.toLowerCase());
    console.log(`Uživatel ${email} aktualizován jako správce.`);
  } else {
    db.prepare(`INSERT INTO users (email, password_hash, first_name, last_name, is_admin, is_active)
                VALUES (?, ?, ?, ?, 1, 1)`).run(email.toLowerCase(), hash, firstName, lastName);
    console.log(`Superuživatel ${email} vytvořen.`);
  }
} catch (err) {
  console.error('Chyba:', err.message);
} finally {
  closeAll();
}
