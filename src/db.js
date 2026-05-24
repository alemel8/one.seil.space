import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Monitoring data (latest.json, history.sqlite) — plní collector
const STATS_DIR = process.env.STATS_DIR || path.join(projectRoot, 'data');

// Aplikační databáze — Dockerfile vytváří /app/data se správnými právy,
// Coolify mountuje persistent storage tam. Env var APP_DATA_DIR pro přepsání.
const APP_DATA_DIR = process.env.APP_DATA_DIR || path.join(projectRoot, 'data');
if (!existsSync(APP_DATA_DIR)) {
  try { mkdirSync(APP_DATA_DIR, { recursive: true }); } catch { /* volume mount existuje */ }
}

const HISTORY_DB_PATH = path.join(STATS_DIR, 'history.sqlite');
const APP_DB_PATH = path.join(APP_DATA_DIR, 'app.sqlite');

let _historyDb = null;
let _appDb = null;

export function getHistoryDb() {
  if (_historyDb) return _historyDb;
  if (!existsSync(HISTORY_DB_PATH)) return null;
  _historyDb = new Database(HISTORY_DB_PATH, { readonly: true });
  return _historyDb;
}

export function getAppDb() {
  if (_appDb) return _appDb;
  _appDb = new Database(APP_DB_PATH);
  _appDb.pragma('journal_mode = WAL');
  _appDb.pragma('foreign_keys = ON');
  _initAppSchema(_appDb);
  return _appDb;
}

function _initAppSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      first_name TEXT DEFAULT '',
      last_name TEXT DEFAULT '',
      is_admin INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      photo TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS crm_companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      company_type TEXT DEFAULT 'Zákazník',
      country TEXT DEFAULT '',
      city TEXT DEFAULT '',
      email TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      website TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      modified_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS crm_contacts (
      id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT DEFAULT '',
      company_id TEXT REFERENCES crm_companies(id) ON DELETE SET NULL,
      title TEXT DEFAULT '',
      email TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      modified_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accounting_orders (
      id TEXT PRIMARY KEY,
      number TEXT NOT NULL,
      subject TEXT DEFAULT '',
      amount REAL DEFAULT 0,
      currency TEXT DEFAULT 'CZK',
      status TEXT DEFAULT 'Nová',
      company_id TEXT REFERENCES crm_companies(id) ON DELETE SET NULL,
      date TEXT DEFAULT (date('now')),
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accounting_invoices_received (
      id TEXT PRIMARY KEY,
      number TEXT NOT NULL,
      supplier TEXT DEFAULT '',
      amount REAL DEFAULT 0,
      currency TEXT DEFAULT 'CZK',
      status TEXT DEFAULT 'Nezaplaceno',
      due_date TEXT DEFAULT '',
      date TEXT DEFAULT (date('now')),
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accounting_invoices_issued (
      id TEXT PRIMARY KEY,
      number TEXT NOT NULL,
      client TEXT DEFAULT '',
      amount REAL DEFAULT 0,
      currency TEXT DEFAULT 'CZK',
      status TEXT DEFAULT 'Nezaplacena',
      due_date TEXT DEFAULT '',
      date TEXT DEFAULT (date('now')),
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accounting_bank (
      id TEXT PRIMARY KEY,
      description TEXT DEFAULT '',
      amount REAL DEFAULT 0,
      currency TEXT DEFAULT 'CZK',
      type TEXT DEFAULT 'Příjem',
      date TEXT DEFAULT (date('now')),
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

export function closeAll() {
  if (_historyDb) { _historyDb.close(); _historyDb = null; }
  if (_appDb) { _appDb.close(); _appDb = null; }
}
