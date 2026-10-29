/**
 * Napojení e-shopu na marketingové platformy (`marketing_sources`).
 *
 * Jeden řádek na dvojici e-shop × platforma: externí ID (property GA4,
 * zákazník Google Ads, provozovna Zboží…), případný token zašifrovaný přes
 * tajemstvi.js a stav posledního stažení. Odsud čte karta „Marketing“
 * v nastavení e-shopu a noční sync (sync.js); tady je i jediný seznam
 * platforem s popisky pro formulář, ať se nastavení a sync nerozejdou.
 *
 * ## Proč v databázi, a ne v env
 *
 * E-shopy se zakládají v administraci. Token v env by znamenal deploy při
 * každém novém e-shopu a pojmenovací schéma proměnných; v databázi leží
 * šifrovaný klíčem MARKETING_SECRETS_KEY a v administraci se ukazuje jen
 * otisk (plán D6). Google (GA4, Ads, Search Console, Merchant) token
 * nepotřebuje — jede přes firemní service account z GOOGLE_SERVICE_ACCOUNT_JSON
 * a e-shop si jen přidá jeho e-mail jako čtenáře.
 *
 * ## Tajemství e-shopu
 *
 * Platforma `eshop` volá statistiku samotného e-shopu s hlavičkou
 * x-webhook-secret. Toneráček podepisuje balíky i statistiku proměnnou
 * SHOP_WEBHOOK_SECRET z prostředí (stejně jako expedice), ostatní e-shopy
 * mají `shops.webhook_secret`; vlastní token ve zdroji má přednost, když
 * ho někdo vyplní — třeba pro e-shop na jiném hostingu.
 */

import { jenDatum } from '../prazsky-cas.js';
import { desifruj, maKlic, otiskTajemstvi, zasifruj } from './tajemstvi.js';

/** E-shop, který bere tajemství z prostředí (stejná konstanta jako v settings.js a expedice.js). */
const ESHOP_S_TAJEMSTVIM_Z_PROSTREDI = 'toneracek';

/** Nejdelší externí ID / adresa property; delší je skoro jistě chyba při kopírování. */
export const MAX_DELKA_ID = 200;

/**
 * Platformy v pořadí, v jakém se ukazují v nastavení. `potrebujeTajemstvi`
 * řídí pole pro token, prázdný `popisExternalId` pole skryje. `zbozi` tu
 * není — Zboží.cz API skončilo 16. 3. 2026 a statistiky Nákupů plní adaptér
 * Skliku (plán D9); vysvětluje to poznámka u Skliku.
 */
export const PLATFORMY_NASTAVENI = [
  {
    platform: 'ga4', popis: 'Google Analytics 4', potrebujeTajemstvi: false,
    popisExternalId: 'ID property GA4 (číslo, ne G-…)', popisParentId: '',
    napoveda: 'Správa → Správa přístupu k vlastnosti → e-mail service accountu jako Čtenář.',
  },
  {
    platform: 'google_ads', popis: 'Google Ads', potrebujeTajemstvi: false,
    popisExternalId: 'ID zákazníka Google Ads (bez pomlček)', popisParentId: 'ID správcovského účtu (MCC), jen přes agenturu',
    napoveda: 'Správce → Přístup a zabezpečení → Uživatelé → e-mail service accountu, Jen pro čtení. Cloud projekt musí mít u Google Ads API úroveň Explorer.',
  },
  {
    platform: 'search_console', popis: 'Search Console', potrebujeTajemstvi: false,
    popisExternalId: 'Adresa property (sc-domain:toneracek.cz nebo https://…/)', popisParentId: '',
    napoveda: 'Nastavení → Uživatelé → e-mail service accountu (omezený přístup).',
  },
  {
    platform: 'merchant', popis: 'Merchant Center', potrebujeTajemstvi: false,
    popisExternalId: 'ID účtu Merchant Center', popisParentId: '',
    napoveda: 'Nastavení → Lidé a přístup → e-mail service accountu s rolí Výkon a statistiky.',
  },
  {
    platform: 'sklik', popis: 'Sklik + Zboží.cz (Seznam Nákupy)', potrebujeTajemstvi: true,
    popisExternalId: 'ID účtu Sklik (volitelné)', popisParentId: 'ID provozovny Zboží.cz (premiseId), volitelné',
    popisTajemstvi: 'klíč API Fénix s právem jen pro čtení (r)',
    napoveda: 'Klíč jde založit jen po přímém přihlášení majitele účtu: Nastavení → Správa klíčů API Fénix. Kampaně typu Nákupy se ukládají jako Zboží.cz.',
  },
  {
    platform: 'heureka', popis: 'Heureka', potrebujeTajemstvi: true,
    popisExternalId: '', popisParentId: '',
    popisTajemstvi: 'API klíč měření konverzí',
    napoveda: 'Administrace → Statistiky a reporty → API měření konverzí. Funguje jen s novým dvouskriptovým měřením na webu.',
  },
  {
    platform: 'meta', popis: 'Meta (Facebook, Instagram)', potrebujeTajemstvi: true,
    popisExternalId: 'ID reklamního účtu (bez act_)', popisParentId: '',
    popisTajemstvi: 'token systémového uživatele s oprávněním ads_read',
    napoveda: 'Business Settings → Systémoví uživatelé → token; token s platností 60 dní je potřeba včas obnovit.',
  },
  {
    platform: 'eshop', popis: 'E-shop (hledání bez výsledku, opuštěné košíky)', potrebujeTajemstvi: true,
    popisExternalId: '', popisParentId: '',
    popisTajemstvi: 'tajemství x-webhook-secret (prázdné = tajemství e-shopu, u Toneráčku SHOP_WEBHOOK_SECRET z prostředí)',
    napoveda: 'Statistika se čte z adresy e-shopu uložené u e-shopu (/api/marketing/statistika).',
  },
];

export const PLATFORMY_ZDROJU = PLATFORMY_NASTAVENI.map(p => p.platform);

export class ZdrojError extends Error {
  constructor(kod, zprava) {
    super(zprava || kod);
    this.name = 'ZdrojError';
    this.kod = kod;
  }
}

/**
 * Všechny platformy pro nastavení e-shopu: popisky + uložený řádek (nebo
 * null) + otisk tajemství. Řádek bez záznamu v databázi má `zdroj: null`,
 * formulář ho založí prvním uložením.
 */
export async function nactiZdroje(sql, shopId) {
  const radky = await sql`
    SELECT id, platform, active, external_id, parent_external_id,
           secret_fingerprint, secret_set_at, since::text AS since,
           last_run_at, last_ok_at, last_error, created_at, modified_at
    FROM marketing_sources WHERE shop_id = ${shopId}`;
  const podlePlatformy = new Map(radky.map(r => [r.platform, r]));
  return PLATFORMY_NASTAVENI.map(p => {
    const zdroj = podlePlatformy.get(p.platform) ?? null;
    return {
      ...p,
      zdroj,
      aktivni: zdroj ? zdroj.active : false,
      maTajemstvi: Boolean(zdroj?.secret_fingerprint),
      otisk: zdroj?.secret_fingerprint || '',
    };
  });
}

/** Aktivní zdroje všech aktivních e-shopů pro sync — Toneráček první (stejné pořadí jako expedice). */
export async function aktivniZdroje(sql) {
  return sql`
    SELECT src.*, s.slug, s.name AS shop_name, s.url AS shop_url, s.webhook_secret AS shop_webhook_secret,
           s.marketing_pno_alert_pct::float8 AS marketing_pno_alert_pct
    FROM marketing_sources src
    JOIN shops s ON s.id = src.shop_id
    WHERE src.active AND s.active
    ORDER BY (s.slug = ${ESHOP_S_TAJEMSTVIM_Z_PROSTREDI}) DESC, s.id, src.platform`;
}

function ocistiId(hodnota) {
  const text = String(hodnota ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (text.length > MAX_DELKA_ID) throw new ZdrojError('marketing-hodnota', `Hodnota je delší než ${MAX_DELKA_ID} znaků`);
  return text;
}

/**
 * Uloží (upsert) napojení platformy. `secret` prázdný = beze změny;
 * `akce === 'vymazat-tajemstvi'` token smaže. Vyhazuje ZdrojError s kódem
 * pro `?error=`: marketing-platforma, marketing-hodnota, marketing-datum,
 * marketing-klic (token bez MARKETING_SECRETS_KEY).
 */
export async function ulozZdroj(sql, { shopId, platform, active, externalId, parentExternalId, since, secret, akce }) {
  if (!PLATFORMY_ZDROJU.includes(platform)) throw new ZdrojError('marketing-platforma', 'Neznámá platforma');
  const external = ocistiId(externalId);
  const parent = ocistiId(parentExternalId);
  const sinceText = String(since ?? '').trim();
  const sinceDatum = sinceText ? jenDatum(sinceText) : null;
  if (sinceText && !sinceDatum) throw new ZdrojError('marketing-datum', 'Datum „stahovat od“ musí být RRRR-MM-DD');
  const jeAktivni = active === true || active === 'on' || active === '1' || active === 'true';

  // Token: nový se zašifruje, prázdné pole nechá uložený, akce vymazat ho smaže.
  // Řeší se v INSERTu i v UPDATE — první uložení řádku jde INSERTem a ON
  // CONFLICT se nespustí, takže token jen v UPDATE by se napoprvé zahodil.
  let novyToken = null;
  const vymazat = akce === 'vymazat-tajemstvi';
  if (!vymazat) {
    const token = String(secret ?? '').trim();
    if (token) {
      if (!maKlic()) throw new ZdrojError('marketing-klic', 'MARKETING_SECRETS_KEY není nastavený');
      if (/\s/.test(token)) throw new ZdrojError('marketing-hodnota', 'Token nesmí obsahovat mezery');
      novyToken = token;
    }
  }
  const secretEnc = novyToken ? zasifruj(novyToken) : '';
  const secretFp = novyToken ? otiskTajemstvi(novyToken) : '';
  const menitTajemstvi = vymazat || novyToken != null;

  const [radek] = await sql`
    INSERT INTO marketing_sources
      (shop_id, platform, active, external_id, parent_external_id, since, secret_enc, secret_fingerprint, secret_set_at)
    VALUES (${shopId}, ${platform}, ${jeAktivni}, ${external}, ${parent}, ${sinceDatum},
            ${secretEnc}, ${secretFp}, ${novyToken ? sql`NOW()` : null})
    ON CONFLICT (shop_id, platform) DO UPDATE SET
      active = EXCLUDED.active,
      external_id = EXCLUDED.external_id,
      parent_external_id = EXCLUDED.parent_external_id,
      since = EXCLUDED.since,
      secret_enc = CASE WHEN ${menitTajemstvi} THEN EXCLUDED.secret_enc ELSE marketing_sources.secret_enc END,
      secret_fingerprint = CASE WHEN ${menitTajemstvi} THEN EXCLUDED.secret_fingerprint ELSE marketing_sources.secret_fingerprint END,
      secret_set_at = CASE WHEN ${menitTajemstvi} THEN EXCLUDED.secret_set_at ELSE marketing_sources.secret_set_at END,
      modified_at = NOW()
    RETURNING *`;
  return radek;
}

/** Marže a práh PNO e-shopu (0–100 %, 2 desetinná místa); vrací ZdrojError('marketing-procenta'). */
export async function nastavMarketingEshopu(sql, shopId, { marzePct, pnoAlertPct }) {
  const procenta = (hodnota) => {
    const n = Number(String(hodnota ?? '').replace(',', '.').trim() || 0);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new ZdrojError('marketing-procenta', 'Procenta musí být 0–100');
    return Math.round(n * 100) / 100;
  };
  const marze = procenta(marzePct);
  const prah = procenta(pnoAlertPct);
  await sql`
    UPDATE shops SET marketing_margin_pct = ${marze}, marketing_pno_alert_pct = ${prah}
    WHERE id = ${shopId}`;
  return { marze, prah };
}

/**
 * Token pro volání platformy: dešifrované tajemství zdroje; u platformy
 * `eshop` bez vlastního tokenu tajemství e-shopu (Toneráček z prostředí,
 * ostatní `shops.webhook_secret`). Vrací '' když nic není; dešifrování
 * s cizím klíčem nechá vyhodit TajemstviError — to má sync hlásit jako
 * trvalou chybu, ne tiše stahovat bez tokenu.
 */
export function tajemstviZdroje(zdroj, shop, env = process.env) {
  if (zdroj?.secret_enc) return desifruj(zdroj.secret_enc);
  if (zdroj?.platform !== 'eshop') return '';
  if (shop?.slug === ESHOP_S_TAJEMSTVIM_Z_PROSTREDI) return env.SHOP_WEBHOOK_SECRET || '';
  return shop?.webhook_secret || shop?.shop_webhook_secret || '';
}

/** Poslední běhy syncu e-shopu pro nastavení a stránku Synchronizace. */
export async function behySyncu(sql, shopId, limit = 50) {
  return sql`
    SELECT r.*, TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS spustil
    FROM marketing_sync_runs r
    LEFT JOIN users u ON u.id = r.started_by
    WHERE r.shop_id = ${shopId}
    ORDER BY r.started_at DESC
    LIMIT ${limit}`;
}
