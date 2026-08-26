import { Resend } from 'resend';
import { brandReplyTo, brandSender } from './brand.js';
import {
  banner, cta, emailShell, esc, infoBlock, infoRow, note,
  paymentBlock, sectionLabel, trackingBlock,
} from './email-templates.js';

let resend = null;
function getResend() {
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}

// Odesílatel firemní pošty (faktury mimo e-shop, upomínky B2B). Zákaznické
// e-maily e-shopů si odesílatele berou ze značky v `shops` — viz src/brand.js.
//
//   MAIL_FROM      — plná adresa včetně jména, např. "SEIL s.r.o. <noreply@seil.cz>"
//   MAIL_REPLY_TO  — kam mají chodit odpovědi; z noreply schránky se neodpovídá
const MAIL_FROM     = process.env.MAIL_FROM || 'SEIL s.r.o. <noreply@seil.cz>';
const MAIL_REPLY_TO = process.env.MAIL_REPLY_TO || '';

export function companySenderFor(issuer) {
  if (process.env.MAIL_FROM) return process.env.MAIL_FROM;
  // Jméno bereme z nastavení firmy, adresu drží noreply
  return issuer?.name ? `${issuer.name} <noreply@seil.cz>` : MAIL_FROM;
}

export function companyReplyToFor(issuer) {
  return MAIL_REPLY_TO || issuer?.email || undefined;
}

/**
 * Adresy v doménách vyhrazených RFC 2606 nemohou existovat. Odeslat na ně jde
 * — Resend zprávu přijme a teprve pak nahlásí hard bounce, který jde na účet
 * reputace naší domény. Osm takových bounces z `noreply@seil.cz` nadělal test
 * `test/invoices.test.js`, který posílá na `test@example.invalid` proti
 * běžícímu serveru s ostrým klíčem v prostředí. Levnější je odmítnout je tady
 * než ve všech volajících.
 */
function isUndeliverable(to) {
  const address = (String(to).match(/<([^>]*)>/)?.[1] ?? String(to)).trim().toLowerCase();
  const domain = address.split('@')[1] ?? '';
  return /(^|\.)(test|example|invalid|localhost)$/.test(domain)
      || /(^|\.)example\.(com|net|org)$/.test(domain);
}

/**
 * Jediné hrdlo, kterým prochází veškeré odesílání.
 *
 * `audience: 'customer'` znamená zákazníka e-shopu — takový e-mail nesmí
 * odejít z domény SEILu ani omylem. Dřív se to stávalo tiše: volající
 * nepředal odesílatele, `senderFor()` spadl na firemní adresu a zákazník
 * Toneráčku dostal fakturu od SEIL s.r.o. Druhá pojistka je CHECK constraint
 * v migraci 030.
 */
async function deliver({ audience, from, replyTo, to, subject, html, attachments }) {
  if (audience === 'customer' && /@seil\.cz>?\s*$/i.test(from)) {
    throw new Error(`Zákaznický e-mail se pokusil odejít z firemní adresy: ${from}`);
  }

  if (isUndeliverable(to)) {
    throw new Error(`Adresa nemůže existovat, neodesílám: ${to}`);
  }

  if (!process.env.RESEND_API_KEY) {
    console.log(`[DEV EMAIL] To: ${to} | From: ${from} | Subject: ${subject}`);
    return;
  }

  const { error } = await getResend().emails.send({
    from, to: [to], subject, html,
    ...(replyTo ? { replyTo } : {}),
    ...(attachments ? { attachments } : {}),
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
}

function pdfAttachment(invoice, pdfBuffer) {
  if (!pdfBuffer) return undefined;
  return [{
    filename: `faktura-${invoice.number}.pdf`,
    content: Buffer.from(pdfBuffer).toString('base64'),
  }];
}

const money = (amount, currency) =>
  `${Number(amount).toLocaleString('cs-CZ', { minimumFractionDigits: 2 })} ${currency || 'Kč'}`;

const czDate = (value) => (value ? new Date(value).toLocaleDateString('cs-CZ') : '—');

/** Odkaz na sledování zásilky Packety; čísla bez písmene na začátku mají prefix Z. */
export function packetaTrackingUrl(trackingNumber) {
  const id = String(trackingNumber).replace(/\s+/g, '');
  return `https://tracking.packeta.com/cs/${/^[A-Za-z]/.test(id) ? id : 'Z' + id}`;
}

/**
 * Adresa obrázku s QR platbou (SPAYD).
 *
 * Generuje ji e-shop na `/api/qr`, ne Seil: QR musí být veřejně dostupný
 * obrázek, protože Gmail zahazuje `data:` v `<img>`, a e-shop takový endpoint
 * už má a drží doménu, ze které e-mail odchází. Pro e-shop bez `/api/qr` se
 * prostě nevykreslí — proto jen doplněk pod platebními údaji, nikdy jediná
 * cesta k zaplacení.
 */
export function qrPaymentImageUrl(brand, { iban, amount, variableSymbol, message }) {
  if (!brand?.url || !iban || !amount || !variableSymbol) return undefined;
  const params = new URLSearchParams({
    amount: Number(amount).toFixed(2),
    vs: String(variableSymbol),
    acc: String(iban),
    format: 'png',
  });
  if (message) params.set('message', message);
  return `${brand.url}/api/qr?${params.toString()}`;
}

// ── Storno objednávky ────────────────────────────────────────
//
// Jediný stavový e-mail, který zbyl. „Objednávka se zpracovává" duplikovala
// děkovný e-mail z e-shopu — a přicházela z druhé identity o pár minut
// později, což byla ta nejviditelnější stopa „dva systémy". Větev
// „Vyřízena" byla nedosažitelná (volající ten stav přeskakuje), protože
// vyřízení hlásí sendInvoiceEmail spolu s fakturou a sledovacím číslem.

export async function sendOrderCancelledEmail({ brand, issuer, orderNumber, email, customerName }) {
  // Bez značky raději neposlat než poslat od cizí firmy — viz deliver().
  if (!brand) throw new Error(`Objednávka #${orderNumber} nemá značku e-shopu, storno e-mail se neodesílá`);

  const subject = `Objednávka #${orderNumber} – stornována`;

  const contact = brand.support_email
    ? `Máte dotazy? Napište nám na <a href="mailto:${esc(brand.support_email)}" style="color:${brand.color_primary};text-decoration:none">${esc(brand.support_email)}</a>`
    : '';

  const html = emailShell({
    brand, issuer, title: `Objednávka #${orderNumber}`,
    bannerHtml: banner({
      tone: 'red', icon: '❌',
      title: `Objednávka #${orderNumber} byla stornována`,
      subtitle: 'Nic vám nebude účtováno',
    }),
    body: `
        <p style="font-size:15px;color:#334155;margin:0 0 16px">Dobrý den, <strong>${esc(customerName || 'zákazníku')}</strong>,</p>
        <p style="font-size:14px;color:#475569;line-height:1.6;margin:0 0 20px">
          Vaši objednávku jsme stornovali. Pokud jste už zaplatili, peníze vám vrátíme zpět.
        </p>
        ${cta(brand, `${brand.url}/produkty`, 'Zpět do e-shopu →')}
        ${contact ? note(contact) : ''}`,
  });

  await deliver({
    audience: 'customer', from: brandSender(brand), replyTo: brandReplyTo(brand),
    to: email, subject, html,
  });
}

// ── Upomínky ─────────────────────────────────────────────────
//
// Tři stupně důrazu. Upomínku vždy odesílá člověk z UI, worker ji jen
// připraví — proto tu není žádná automatika, jen text podle stupně.
//
// U zákazníka e-shopu se používá mírnější dvoustupňová varianta: předžalobní
// výzva spotřebiteli kvůli neuhrazené zálohové faktuře za toner je právně
// neobratná a pověsti e-shopu neprospěje. Nezaplacená záloha se u B2C řeší
// stornem objednávky.

const REMINDER_LEVELS_B2B = {
  1: {
    subject: (n) => `Upozornění na neuhrazenou fakturu ${n}`,
    heading: 'Upozornění na neuhrazenou fakturu',
    body: 'dovolujeme si Vás upozornit, že níže uvedená faktura je po splatnosti. Pokud jste ji už uhradili, považujte prosím tuto zprávu za bezpředmětnou.',
    color: '#d97706',
  },
  2: {
    subject: (n) => `Upomínka k neuhrazené faktuře ${n}`,
    heading: 'Upomínka k úhradě',
    body: 'evidujeme, že níže uvedená faktura zůstává i přes naše upozornění neuhrazena. Prosíme o její úhradu v nejbližším možném termínu.',
    color: '#ea580c',
  },
  3: {
    subject: (n) => `Předžalobní výzva k úhradě faktury ${n}`,
    heading: 'Předžalobní výzva k úhradě',
    body: 'níže uvedená faktura je i přes opakované výzvy neuhrazena. Vyzýváme Vás k úhradě dlužné částky. Nebude-li uhrazena, budeme nuceni pohledávku vymáhat soudní cestou včetně příslušenství a nákladů řízení.',
    color: '#dc2626',
  },
};

const REMINDER_LEVELS_B2C = {
  1: {
    subject: (n) => `Připomínáme platbu k objednávce`,
    heading: 'Objednávka čeká na platbu',
    body: 'vaši objednávku máme připravenou, ale platba nám zatím nedorazila. Pokud jste ji už poslali, považujte prosím tuto zprávu za bezpředmětnou.',
    color: '#d97706',
  },
  2: {
    subject: (n) => `Poslední připomenutí platby`,
    heading: 'Poslední připomenutí',
    body: 'platba k vaší objednávce nám stále nedorazila. Pokud o zboží už nemáte zájem, nemusíte nic dělat, objednávku po čase stornujeme.',
    color: '#ea580c',
  },
};

export function reminderLevelConfig(level, isShopCustomer = false) {
  const table = isShopCustomer ? REMINDER_LEVELS_B2C : REMINDER_LEVELS_B2B;
  return table[level] || table[2] || table[1];
}

export async function sendReminderEmail({
  invoice, issuer, brand, email, pdfBuffer, level = 2, daysOverdue = 0, paymentDetails,
}) {
  const cfg = reminderLevelConfig(level, Boolean(brand));
  const subject = cfg.subject(invoice.number);
  const attachments = pdfAttachment(invoice, pdfBuffer);

  // Zákazník e-shopu platí z mobilu, takže pod údaji dostane i QR kód.
  // Firemní klient dostává upomínku do účtárny, kde se platí z výpisu.
  const payment = paymentDetails && brand
    ? {
        ...paymentDetails,
        qrImageUrl: qrPaymentImageUrl(brand, {
          iban: paymentDetails.iban,
          amount: invoice.total_amount,
          variableSymbol: paymentDetails.variableSymbol,
          message: `Faktura ${invoice.number}`,
        }),
      }
    : paymentDetails;

  const rows = [
    infoRow('Číslo faktury', esc(invoice.number)),
    infoRow('Splatnost', czDate(invoice.due_date)),
    infoRow('Po splatnosti', `<span style="color:${cfg.color};font-weight:600">${daysOverdue} dní</span>`),
    infoRow('Dlužná částka', `<strong>${money(invoice.total_amount, invoice.currency)}</strong>`),
  ].join('');

  const body = `
        <p style="font-size:15px;color:#334155;margin:0 0 16px">Dobrý den,</p>
        <p style="font-size:14px;color:#475569;line-height:1.6;margin:0 0 20px">${esc(cfg.body)}</p>
        ${infoBlock('Faktura', rows)}
        ${payment ? paymentBlock(payment) : ''}
        ${pdfBuffer ? note('Fakturu přikládáme znovu v příloze.') : ''}`;

  // Zákazník e-shopu vidí značku e-shopu, firemní klient SEIL.
  if (brand) {
    const html = emailShell({
      brand, issuer, title: subject,
      bannerHtml: banner({ tone: 'amber', icon: '⏳', title: cfg.heading, subtitle: `Faktura ${invoice.number}` }),
      body,
    });
    await deliver({
      audience: 'customer', from: brandSender(brand), replyTo: brandReplyTo(brand),
      to: email, subject, html, attachments,
    });
    return { subject };
  }

  const html = `<!DOCTYPE html>
<html lang="cs"><head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Inter,-apple-system,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">
  <div style="background:${cfg.color};border-radius:14px 14px 0 0;padding:24px 32px;text-align:center">
    <div style="font-size:20px;font-weight:700;color:#fff">${esc(cfg.heading)}</div>
    <div style="font-size:14px;color:rgba(255,255,255,0.85);margin-top:6px">Faktura ${esc(invoice.number)}</div>
  </div>
  <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 14px 14px;padding:28px 32px">
${body}
    <p style="font-size:14px;color:#334155;margin:16px 0 0">${esc(issuer?.name || '')}</p>
  </div>
</div>
</body></html>`;

  await deliver({
    audience: 'company', from: companySenderFor(issuer), replyTo: companyReplyToFor(issuer),
    to: email, subject, html, attachments,
  });
  return { subject };
}

// ── Faktury ──────────────────────────────────────────────────

/**
 * Faktura zákazníkovi. `brand` je povinný u dokladů e-shopu (invoice.shop_id) —
 * bez něj by e-mail o vyřízené objednávce odešel jako SEIL s.r.o., což byl
 * největší identitní únik v celém toku. Faktury mimo e-shop (ruční, opakované)
 * `brand` nemají a firemní identita je u nich správně.
 */
export async function sendInvoiceEmail({
  invoice, issuer, brand, email, pdfBuffer, subject, intro, paymentDetails, trackingNumber,
}) {
  const emailSubject = subject || `Faktura ${invoice.number} od ${brand ? brand.name : issuer.name}`;
  const emailIntro = intro || `v příloze zasíláme fakturu č. <strong>${esc(invoice.number)}</strong>.`;
  const attachments = pdfAttachment(invoice, pdfBuffer);

  const summary = [
    infoRow('Číslo faktury', esc(invoice.number)),
    infoRow('Celkem k úhradě', `<strong>${money(invoice.total_amount, invoice.currency)}</strong>`),
    invoice.due_date ? infoRow('Splatnost', czDate(invoice.due_date)) : '',
  ].filter(Boolean).join('');

  const body = `
        <p style="font-size:15px;color:#334155;margin:0 0 16px">Dobrý den,</p>
        <p style="font-size:14px;color:#475569;line-height:1.6;margin:0 0 20px">${emailIntro}</p>
        ${infoBlock('Faktura', summary)}
        ${paymentDetails ? paymentBlock(paymentDetails) : ''}
        ${trackingNumber ? trackingBlock(brand ?? { color_primary: '#0891b2' }, trackingNumber, packetaTrackingUrl(trackingNumber)) : ''}
        ${note('Fakturu naleznete v příloze tohoto e-mailu.')}`;

  if (brand) {
    const html = emailShell({
      brand, issuer, title: emailSubject,
      bannerHtml: banner({
        tone: trackingNumber ? 'blue' : 'green',
        icon: trackingNumber ? '📦' : '🧾',
        title: emailSubject,
        subtitle: trackingNumber ? 'Zásilka je na cestě' : undefined,
      }),
      body,
    });
    await deliver({
      audience: 'customer', from: brandSender(brand), replyTo: brandReplyTo(brand),
      to: email, subject: emailSubject, html, attachments,
    });
    return;
  }

  const html = `<!DOCTYPE html>
<html lang="cs"><head><meta charset="utf-8"><title>${esc(emailSubject)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Inter,-apple-system,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">
  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px 32px">
${body}
    <p style="font-size:14px;color:#334155;margin:16px 0 0">${esc(issuer?.name || '')}</p>
  </div>
</div>
</body></html>`;

  await deliver({
    audience: 'company', from: companySenderFor(issuer), replyTo: companyReplyToFor(issuer),
    to: email, subject: emailSubject, html, attachments,
  });
}
