/**
 * Šifrování tokenů marketingových platforem uložených v databázi
 * (`marketing_sources.secret_enc`).
 *
 * Sklik, Heureka a Meta potřebují token, který patří konkrétnímu e-shopu.
 * E-shopy se zakládají v administraci, takže token nemůže žít v env
 * (každý nový e-shop by znamenal deploy) — leží v databázi, ale šifrovaný
 * AES-256-GCM klíčem z env `MARKETING_SECRETS_KEY` (plán D6). Záloha
 * databáze tak tokeny neprozradí a v administraci se ukazuje jen otisk.
 *
 * ## Tvar uloženého tajemství
 *
 * `v1:<iv base64>:<tag base64>:<data base64>` — 12bajtový náhodný IV
 * (doporučená délka pro GCM; nikdy se neopakuje pro tentýž klíč, proto
 * náhodný při každém šifrování), 16bajtový ověřovací tag, pak šifrovaný
 * text. Verze vpředu, aby šlo klíč nebo algoritmus jednou vyměnit a staré
 * řádky přitom rozpoznat.
 *
 * ## Klíč se čte při každém volání
 *
 * Žádná cache: testy klíč nastavují a mění za běhu a server při startu
 * bez klíče nesmí spadnout — bez klíče jen nejde uložit ani přečíst token
 * a nastavení to řekne (`maKlic()`).
 *
 * Otisk je prvních 8 hex znaků SHA-256 — stejná konvence jako u klíčů
 * e-shopů (src/eshop-klice.js), odkud se bere i výpočet.
 */

import crypto from 'node:crypto';
import { hashKlice, otiskKlice } from '../eshop-klice.js';

const ALGORITMUS = 'aes-256-gcm';
const DELKA_IV = 12;
const DELKA_TAGU = 16;
const VERZE = 'v1';

export class TajemstviError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TajemstviError';
  }
}

function surovyKlic() {
  return String(process.env.MARKETING_SECRETS_KEY ?? '').trim();
}

/** Je v prostředí použitelný klíč (64 hex znaků = 32 bajtů)? */
export function maKlic() {
  return /^[0-9a-fA-F]{64}$/.test(surovyKlic());
}

function nactiKlic() {
  const klic = surovyKlic();
  if (!klic) throw new TajemstviError('MARKETING_SECRETS_KEY není nastaveno — tokeny platforem nejde uložit ani přečíst');
  if (!/^[0-9a-fA-F]{64}$/.test(klic)) {
    throw new TajemstviError(`MARKETING_SECRETS_KEY musí mít 64 hex znaků (32 bajtů), má ${klic.length}`);
  }
  return Buffer.from(klic, 'hex');
}

/** Text → `v1:<iv>:<tag>:<data>`. Dvojí šifrování téhož textu dá různé výsledky (náhodný IV). */
export function zasifruj(text) {
  const klic = nactiKlic();
  const iv = crypto.randomBytes(DELKA_IV);
  const sifra = crypto.createCipheriv(ALGORITMUS, klic, iv);
  const data = Buffer.concat([sifra.update(String(text ?? ''), 'utf8'), sifra.final()]);
  const tag = sifra.getAuthTag();
  return [VERZE, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

/**
 * `v1:<iv>:<tag>:<data>` → text. Chyby česky: chybějící klíč, cizí tvar
 * (není z `zasifruj`) a neprošlý ověřovací tag — ten znamená jiný klíč,
 * než kterým se šifrovalo, nebo poškozený řádek.
 */
export function desifruj(enc) {
  const klic = nactiKlic();
  const casti = typeof enc === 'string' ? enc.split(':') : [];
  if (casti.length !== 4 || casti[0] !== VERZE) {
    throw new TajemstviError('uložené tajemství má neznámý tvar — čekám v1:<iv>:<tag>:<data>');
  }
  const iv = Buffer.from(casti[1], 'base64');
  const tag = Buffer.from(casti[2], 'base64');
  const data = Buffer.from(casti[3], 'base64');
  if (iv.length !== DELKA_IV || tag.length !== DELKA_TAGU) {
    throw new TajemstviError('uložené tajemství má neznámý tvar — špatná délka IV nebo tagu');
  }

  try {
    const desifra = crypto.createDecipheriv(ALGORITMUS, klic, iv);
    desifra.setAuthTag(tag);
    return Buffer.concat([desifra.update(data), desifra.final()]).toString('utf8');
  } catch {
    throw new TajemstviError('token nelze dešifrovat — změnil se MARKETING_SECRETS_KEY?');
  }
}

/** Prvních 8 hex znaků SHA-256 textu; prázdný text → ''. Z otisku token zpět nejde. */
export function otiskTajemstvi(text) {
  const t = String(text ?? '');
  return t ? otiskKlice(hashKlice(t)) : '';
}
