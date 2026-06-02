import postgres from 'postgres';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Monitoring data (SQLite, readonly — plní collector, nezávislé na PG)
const STATS_DIR = process.env.STATS_DIR || path.join(projectRoot, 'data');

let _sql = null;

export function getDb() {
  if (_sql) return _sql;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL není nastavena');

  _sql = postgres(url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
    onnotice: () => {},
  });

  return _sql;
}

// Zpětná kompatibilita — starý název
export const getAppDb = getDb;

export async function closeAll() {
  if (_sql) {
    await _sql.end();
    _sql = null;
  }
}

// Monitoring history DB (SQLite, readonly)
let _historyDb = null;

export function getHistoryDb() {
  if (_historyDb) return _historyDb;
  const dbPath = path.join(STATS_DIR, 'history.sqlite');
  if (!existsSync(dbPath)) return null;
  try {
    _historyDb = new Database(dbPath, { readonly: true });
    return _historyDb;
  } catch {
    return null;
  }
}

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}
