/**
 * Načte .env do process.env — bez závislosti na `node --env-file`.
 *
 * Ten přepínač umí až Node 20.6+, na VPS ale bývá starší node a hlásí
 * "bad option: --env-file". Skripty si proto .env načtou samy:
 *
 *   import './lib/load-env.js';   // musí být první import
 *
 * Proměnné, které v prostředí už jsou (docker, systemd, `export`, nebo
 * právě `--env-file`), se nepřepisují — prostředí má vždy přednost.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Vrátí počet proměnných, které se z souboru doplnily. */
export function loadEnv(file = path.join(ROOT, '.env')) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;   // .env nemusí existovat — v kontejneru chodí proměnné z prostředí
  }

  let loaded = 0;
  for (const line of text.split(/\r?\n/)) {
    // komentáře a prázdné řádky se nechytnou, klíč musí začínat písmenem
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;

    const key = m[1];
    let val = m[2].trim();

    if (/^"[\s\S]*"$/.test(val)) {
      val = val.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (/^'[\s\S]*'$/.test(val)) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, '').trim();   // komentář za hodnotou
    }

    if (!(key in process.env)) {
      process.env[key] = val;
      loaded++;
    }
  }
  return loaded;
}

loadEnv();
