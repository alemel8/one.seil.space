import { getDb } from './db.js';

/**
 * Identita e-shopu pro zákaznické e-maily.
 *
 * Do migrace 030 byla natvrdo v kódu (`const FROM` v email.js a literál
 * v toneracek.js), takže nejdůležitější e-mail objednávky chodil od SEIL
 * s.r.o. a druhý e-shop by posílal svá storna jako Toneráček. Teď je to řádek
 * v `shops` a přidat e-shop znamená vyplnit formulář.
 */

// Bez těchhle údajů se zákaznický e-mail neodešle. Neodeslaný e-mail jde
// poslat ručně z administrace; prozrazenou cizí identitu vzít zpět nejde.
const IDENTITY_FIELDS = ['name', 'url', 'email_from_name', 'email_from_address'];

// Kosmetika — když chybí, e-mail vypadá stroze, ale je správně podepsaný.
const COSMETIC_DEFAULTS = {
  support_email: '',
  support_phone: '',
  support_phone_link: '',
  tagline: '',
  claim: '',
  logo_mark_url: '',
  logo_wordmark_url: '',
  color_primary: '#334155',
  color_primary_dark: '#1e293b',
  color_primary_light: '#475569',
  color_on_primary_soft: '#cbd5e1',
};

export class BrandIncompleteError extends Error {
  constructor(shopId, missing) {
    super(`E-shop ${shopId} nemá vyplněnou identitu e-mailů: ${missing.join(', ')}`);
    this.name = 'BrandIncompleteError';
    this.shopId = shopId;
    this.missing = missing;
  }
}

const CACHE_TTL_MS = 60_000;
const cache = new Map();

export function invalidateBrandCache(shopId) {
  if (shopId === undefined) cache.clear();
  else cache.delete(Number(shopId));
}

/**
 * Vrátí značku e-shopu, nebo vyhodí BrandIncompleteError. Volající chybu
 * nesmí spolknout do fallbacku — smyslem je e-mail raději neposlat.
 */
export async function shopBrand(shopId) {
  const id = Number(shopId);
  if (!id) throw new BrandIncompleteError(shopId, ['shop_id']);

  const cached = cache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.brand;

  const sql = getDb();
  const [shop] = await sql`SELECT * FROM shops WHERE id = ${id} LIMIT 1`;
  if (!shop) throw new BrandIncompleteError(id, ['shop']);

  const missing = IDENTITY_FIELDS.filter((f) => !String(shop[f] ?? '').trim());
  if (missing.length) throw new BrandIncompleteError(id, missing);

  const brand = { ...COSMETIC_DEFAULTS };
  for (const [key, fallback] of Object.entries(COSMETIC_DEFAULTS)) {
    const value = String(shop[key] ?? '').trim();
    brand[key] = value || fallback;
  }
  brand.id = shop.id;
  brand.slug = shop.slug;
  brand.name = shop.name;
  brand.url = String(shop.url).replace(/\/$/, '');
  brand.email_from_name = shop.email_from_name;
  brand.email_from_address = shop.email_from_address;
  brand.email_reply_to = shop.email_reply_to;

  cache.set(id, { brand, expiresAt: Date.now() + CACHE_TTL_MS });
  return brand;
}

/** Značka podle objednávky nebo faktury; null u dokladů mimo e-shop. */
export async function brandForShopId(shopId) {
  return shopId ? shopBrand(shopId) : null;
}

export function brandSender(brand) {
  return `${brand.email_from_name} <${brand.email_from_address}>`;
}

export function brandReplyTo(brand) {
  return brand.email_reply_to || brand.support_email || undefined;
}
