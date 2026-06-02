// Spustí všechny nové migrace z adresáře migrations/ (číslované SQL soubory)
// Volá se automaticky při startu serveru.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

export async function runMigrations(sql) {
  // Tabulka pro sledování spuštěných migrací
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  const applied = new Set(
    (await sql`SELECT filename FROM schema_migrations`).map(r => r.filename)
  );

  const files = (await readdir(MIGRATIONS_DIR))
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const content = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`[migrate] Spouštím ${file}`);

    await sql.begin(async tx => {
      await tx.unsafe(content);
      await tx`INSERT INTO schema_migrations (filename) VALUES (${file})`;
    });

    console.log(`[migrate] ✓ ${file}`);
  }
}
