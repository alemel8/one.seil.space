/**
 * Klíče e-shopů pro /api/eshop/* (tabulka eshop_api_keys, migrace 040).
 *
 * Klíč určuje e-shop: kdo pošle klíč Dílny, smí jen na objednávky, doklady
 * a zákazníky Dílny. Proto se e-shop nikdy nebere z URL ani z těla
 * požadavku, jen odsud.
 *
 * V databázi je jen SHA-256 otisk. Klíč má 256 bitů náhody, takže pomalý
 * hash (bcrypt) by nic nepřidal a stál by čas na každém požadavku — e-shop
 * volá One SEIL synchronně z pokladny i z přihlášení.
 *
 * Vyhledání podle otisku přes index časově neprozradí nic použitelného:
 * útočník vidí nanejvýš, jak dlouhý prefix *otisku* svého pokusu se trefil,
 * a z otisku klíč nezíská. Porovnání po nalezení řádku je navíc
 * timingSafeEqual, ať tahle úvaha nestojí jen na chování indexu.
 */

import crypto from 'node:crypto';

/** Délka klíče v bajtech náhody; v hexu dvojnásobek. */
const DELKA_KLICE = 32;

/** Jak často se smí zapsat last_used_at — zápis při každém volání by byl zbytečný. */
const POUZITI_INTERVAL_MS = 5 * 60_000;

/** Kdy se který klíč naposledy zapsal (id → ms). Jen šetří zápisy, o přístupu nerozhoduje. */
const posledniZapis = new Map();

export function hashKlice(klic) {
  return crypto.createHash('sha256').update(String(klic ?? ''), 'utf8').digest('hex');
}

/** Prvních osm znaků otisku — podle toho se klíč pozná v administraci. Klíč z toho nejde zpět. */
export function otiskKlice(hash) {
  return String(hash ?? '').slice(0, 8);
}

/** Nový klíč: `{ klic, hash, otisk }`. Klíč se ukáže jednou a nikam se neukládá. */
export function vygenerujKlic() {
  const klic = crypto.randomBytes(DELKA_KLICE).toString('hex');
  const hash = hashKlice(klic);
  return { klic, hash, otisk: otiskKlice(hash) };
}

/**
 * Klíč z hlavičky `Authorization: Bearer <klíč>`, jinak prázdný řetězec.
 * Délka je omezená, ať se nehashují megabajty z cizích požadavků.
 */
export function klicZHlavicky(authorization) {
  const h = String(authorization ?? '');
  if (!h.startsWith('Bearer ')) return '';
  const klic = h.slice(7).trim();
  return klic.length >= 32 && klic.length <= 256 ? klic : '';
}

/**
 * E-shop podle klíče, nebo null. Platí jen aktivní klíč aktivního e-shopu —
 * vypnutý e-shop se tak dá odstřihnout jedním přepínačem bez mazání klíčů.
 * Vrací celý řádek `shops` a navíc `api_key_id`.
 */
export async function eshopPodleKlice(sql, authorization) {
  const klic = klicZHlavicky(authorization);
  if (!klic) return null;
  const hash = hashKlice(klic);

  const [row] = await sql`
    SELECT s.*, k.id AS api_key_id, k.key_hash AS api_key_hash
    FROM eshop_api_keys k
    JOIN shops s ON s.id = k.shop_id
    WHERE k.key_hash = ${hash} AND k.active = TRUE AND s.active = TRUE
    LIMIT 1
  `;
  if (!row) return null;

  const ocekavany = Buffer.from(row.api_key_hash, 'hex');
  const predlozeny = Buffer.from(hash, 'hex');
  if (ocekavany.length !== predlozeny.length || !crypto.timingSafeEqual(ocekavany, predlozeny)) return null;

  const { api_key_hash: _hash, ...shop } = row;
  void _hash;
  return shop;
}

/**
 * Zapíše last_used_at nejvýš jednou za pět minut na klíč a proces. Nikdy
 * nevyhazuje a nečeká se na něj — požadavek e-shopu kvůli evidenci
 * nesmí zpomalit ani spadnout. Podmínka v SQL drží interval i mezi
 * víc procesy (deploy, kdy chvíli běží starý i nový kontejner).
 */
export function zaznamenejPouziti(sql, keyId, log) {
  const ted = Date.now();
  if (ted - (posledniZapis.get(keyId) ?? 0) < POUZITI_INTERVAL_MS) return;
  posledniZapis.set(keyId, ted);

  sql`
    UPDATE eshop_api_keys SET last_used_at = NOW()
    WHERE id = ${keyId}
      AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '5 minutes')
  `.catch((err) => log?.warn?.({ err, keyId }, 'last_used_at klíče se nepodařilo zapsat'));
}
