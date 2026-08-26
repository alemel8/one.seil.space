/**
 * Společná šablona zákaznických e-mailů.
 *
 * Záměrně kopíruje tvar `src/lib/email.ts` e-shopu řádek po řádku (560px
 * tabulka na #f1f5f9, přechodová hlavička, barevný pruh, bílé tělo, patička
 * s wordmarkem) — cílem je, aby zákazník nepoznal, který systém e-mail
 * odeslal. Když se jedna strana změní, druhá se má dát doladit očima nad
 * diffem, ne překladem mezi dvěma jazyky šablon.
 *
 * Všechny barvy a texty jdou ze značky e-shopu (src/brand.js), nic tu není
 * natvrdo. Jediná výjimka je právní řádka o vystavovateli — ta patří SEILu.
 */

const FONT = 'Inter,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif';

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function brandHeader(brand, subtitle) {
  const sub = subtitle ?? brand.tagline;
  const mark = brand.logo_mark_url
    ? `<img src="${esc(brand.logo_mark_url)}" alt="${esc(brand.name)}" width="86" style="display:block;width:86px;height:auto;margin:10px auto 0;border:0;outline:none" />`
    : '';
  return `
      <tr><td style="background:linear-gradient(135deg,${brand.color_primary_dark},${brand.color_primary},${brand.color_primary_light});border-radius:14px 14px 0 0;padding:22px 32px;text-align:center">
        <a href="${esc(brand.url)}" style="text-decoration:none;display:inline-block">
          <div style="font-size:28px;font-weight:700;color:#ffffff;letter-spacing:-0.5px">${esc(brand.name)}</div>
        </a>
        ${mark}
        ${sub ? `<div style="font-size:20px;font-weight:600;color:${brand.color_on_primary_soft};margin-top:8px">${esc(sub)}</div>` : ''}
      </td></tr>`;
}

export function brandFooter(brand, legalLine) {
  const wordmark = brand.logo_wordmark_url
    ? `<a href="${esc(brand.url)}" style="text-decoration:none;display:inline-block">
          <img src="${esc(brand.logo_wordmark_url)}" alt="${esc(brand.name)}" width="240" style="display:block;width:240px;max-width:100%;height:auto;margin:0 auto 8px;border:0;outline:none;text-decoration:none" />
        </a>`
    : `<a href="${esc(brand.url)}" style="text-decoration:none;font-size:18px;font-weight:700;color:${brand.color_primary}">${esc(brand.name)}</a>`;

  const contact = [
    brand.support_email ? `<a href="mailto:${esc(brand.support_email)}" style="color:${brand.color_primary};text-decoration:none">${esc(brand.support_email)}</a>` : '',
    brand.support_phone ? `<a href="tel:${esc(brand.support_phone_link || brand.support_phone)}" style="color:${brand.color_primary};text-decoration:none">${esc(brand.support_phone)}</a>` : '',
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');

  return `
      <tr><td style="text-align:center;padding:20px 0 8px;border-top:1px solid #e2e8f0">
        ${wordmark}
        ${brand.claim ? `<div style="font-size:13px;color:#64748b;margin-top:2px">${esc(brand.claim)}</div>` : ''}
        ${contact ? `<div style="font-size:12px;color:#94a3b8;margin-top:6px">${contact}</div>` : ''}
        ${legalLine ? `<div style="font-size:11px;color:#cbd5e1;margin-top:10px">${esc(legalLine)}</div>` : ''}
      </td></tr>`;
}

/** Vystavovatel dokladu. Drobná řádka pod patičkou, ne hlavní identita. */
export function legalLine(issuer) {
  if (!issuer?.name) return '';
  return [
    issuer.name,
    [issuer.address, [issuer.zip, issuer.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    issuer.ico ? `IČO ${issuer.ico}` : '',
  ].filter(Boolean).join(' · ');
}

const BANNERS = {
  green: { bg: '#f0fdf4', border: '#d1fae5', title: '#15803d', sub: '#16a34a' },
  blue: { bg: '#eff6ff', border: '#dbeafe', title: '#1e40af', sub: '#2563eb' },
  amber: { bg: '#fffbeb', border: '#fef3c7', title: '#b45309', sub: '#d97706' },
  red: { bg: '#fef2f2', border: '#fee2e2', title: '#b91c1c', sub: '#dc2626' },
};

export function banner({ tone = 'green', icon, title, subtitle }) {
  const c = BANNERS[tone] ?? BANNERS.green;
  return `
      <tr><td style="background:${c.bg};padding:18px 32px;border-left:1px solid ${c.border};border-right:1px solid ${c.border}">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-size:28px;width:40px;vertical-align:middle">${icon}</td>
          <td style="padding-left:12px;vertical-align:middle">
            <div style="font-size:17px;font-weight:700;color:${c.title}">${esc(title)}</div>
            ${subtitle ? `<div style="font-size:13px;color:${c.sub};margin-top:2px">${esc(subtitle)}</div>` : ''}
          </td>
        </tr></table>
      </td></tr>`;
}

export const sectionLabel = (text) =>
  `<div style="font-size:10px;font-weight:700;color:#a1a1aa;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:10px">${esc(text)}</div>`;

/** `value` se nezescapuje — volající sem posílá i odkazy a zvýraznění. */
export const infoRow = (label, value) =>
  `<tr>
    <td style="padding:4px 0;font-size:13px;color:#71717a;width:140px;vertical-align:top">${esc(label)}</td>
    <td style="padding:4px 0;font-size:13px;color:#18181b;font-weight:500">${value}</td>
  </tr>`;

export const infoBlock = (label, rows) => `
        <div style="background:#f4f4f5;border-radius:10px;padding:16px 20px;margin-bottom:20px">
          ${sectionLabel(label)}
          <table cellpadding="0" cellspacing="0" width="100%">${rows}</table>
        </div>`;

export const cta = (brand, href, label) => `
        <div style="text-align:center;margin-bottom:16px">
          <a href="${esc(href)}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,${brand.color_primary_dark},${brand.color_primary_light});color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;letter-spacing:0.01em">${esc(label)}</a>
        </div>`;

export const note = (text) =>
  `<div style="text-align:center;font-size:12px;color:#94a3b8">${text}</div>`;

/** Sledování zásilky. Odkaz dodá volající — dopravce není vlastnost šablony. */
export const trackingBlock = (brand, trackingNumber, trackingUrl) => `
        <div style="background:#eff6ff;border-radius:10px;padding:16px 20px;margin-bottom:20px">
          ${sectionLabel('Sledování zásilky')}
          <table cellpadding="0" cellspacing="0" width="100%">
            ${infoRow('Číslo zásilky', esc(trackingNumber))}
          </table>
          ${trackingUrl ? `<div style="margin-top:8px"><a href="${esc(trackingUrl)}" style="color:${brand.color_primary};text-decoration:none;font-size:13px;font-weight:600">Sledovat zásilku →</a></div>` : ''}
        </div>`;

/**
 * Platební údaje, volitelně s QR kódem pod nimi.
 *
 * `qrImageUrl` musí být veřejná adresa obrázku, ne data: URI — Gmail data:
 * v `<img>` zahazuje, takže vložený QR kód by se u většiny příjemců
 * nezobrazil. Adresu skládá volající, viz qrPaymentImageUrl() v email.js.
 */
export const paymentBlock = (details) => {
  const rows = [
    details.bankAccount ? infoRow('Číslo účtu', esc(details.bankAccount)) : '',
    details.iban ? infoRow('IBAN', esc(details.iban)) : '',
    infoRow('Variabilní symbol', `<strong>${esc(details.variableSymbol)}</strong>`),
    details.amount ? infoRow('Částka', esc(details.amount)) : '',
    details.dueDate ? infoRow('Splatnost', esc(details.dueDate)) : '',
  ].filter(Boolean).join('');

  const qr = details.qrImageUrl ? `
          <div style="text-align:center;margin-top:16px;padding-top:16px;border-top:1px solid #e4e4e7">
            <div style="font-size:12px;color:#64748b;margin-bottom:10px">Platba QR kódem</div>
            <img src="${esc(details.qrImageUrl)}" alt="QR platba" width="200" height="200" style="border:1px solid #e2e8f0;border-radius:10px;padding:8px;background:#fff" />
          </div>` : '';

  return `
        <div style="background:#f4f4f5;border-radius:10px;padding:16px 20px;margin-bottom:20px">
          ${sectionLabel('Platební údaje')}
          <table cellpadding="0" cellspacing="0" width="100%">${rows}</table>${qr}
        </div>`;
};

/**
 * Obálka e-mailu. `body` je obsah bílé karty, `banner` barevný pruh nad ní.
 */
export function emailShell({ brand, title, subtitle, bannerHtml = '', body, issuer }) {
  return `<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:${FONT}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px">
    <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">

      ${brandHeader(brand, subtitle)}
      ${bannerHtml}

      <tr><td style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 14px 14px;padding:28px 32px">
${body}
      </td></tr>

      ${brandFooter(brand, legalLine(issuer))}

    </table>
    </td></tr>
  </table>
</body>
</html>`;
}
