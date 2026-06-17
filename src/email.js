import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = 'Toneráček.cz <ahoj@toneracek.cz>';

const STATUS_CONFIG = {
  'Vyřízena': {
    subject: 'Objednávka vyřízena',
    heading: 'Objednávka byla vyřízena',
    message: 'Vaše objednávka byla úspěšně vyřízena a předána k doručení.',
    color: '#16a34a',
    icon: '✅',
  },
  'Stornována': {
    subject: 'Objednávka stornována',
    heading: 'Objednávka byla stornována',
    message: 'Vaše objednávka byla stornována. Pokud máte jakékoliv dotazy, kontaktujte nás na ahoj@toneracek.cz.',
    color: '#dc2626',
    icon: '❌',
  },
  'Ve zpracování': {
    subject: 'Objednávka se zpracovává',
    heading: 'Objednávka se zpracovává',
    message: 'Vaši objednávku jsme přijali a právě ji zpracováváme.',
    color: '#d97706',
    icon: '🔄',
  },
};

function normalizeStatus(status) {
  if (['Vyřízena', 'Expedována', 'Doručena'].includes(status)) return 'Vyřízena';
  if (['Stornována'].includes(status)) return 'Stornována';
  if (['Ve zpracování', 'Přijata'].includes(status)) return 'Ve zpracování';
  return null;
}

export async function sendOrderStatusEmail({ orderNumber, email, customerName, status, trackingNumber }) {
  const normalized = normalizeStatus(status);
  const config = STATUS_CONFIG[normalized];
  if (!config) {
    console.log(`[EMAIL] Status "${status}" – email se neodesílá.`);
    return;
  }

  const trackingSection = trackingNumber && normalized === 'Vyřízena'
    ? `<div style="background:#eff6ff;border-radius:10px;padding:16px 20px;margin-bottom:20px">
        <div style="font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#94a3b8;margin-bottom:8px">Sledování zásilky</div>
        <table cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td style="font-size:13px;color:#64748b;padding:4px 0;width:40%">Číslo zásilky</td>
            <td style="font-size:13px;color:#0f172a;font-weight:500;padding:4px 0">${trackingNumber}</td>
          </tr>
        </table>
       </div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="cs">
<head><meta charset="utf-8"><title>Objednávka #${orderNumber}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Inter,-apple-system,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">
  <div style="background:${config.color};border-radius:14px 14px 0 0;padding:28px 32px;text-align:center">
    <div style="font-size:32px;margin-bottom:8px">${config.icon}</div>
    <div style="font-size:22px;font-weight:700;color:#fff">${config.heading}</div>
    <div style="font-size:14px;color:rgba(255,255,255,0.85);margin-top:6px">Objednávka #${orderNumber}</div>
  </div>
  <div style="background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 14px 14px;padding:28px 32px">
    <p style="font-size:15px;color:#334155;margin:0 0 20px">Dobrý den, <strong>${customerName}</strong>,</p>
    <p style="font-size:14px;color:#475569;line-height:1.6;margin:0 0 20px">${config.message}</p>
    ${trackingSection}
    <hr style="border:none;border-top:1px solid #e4e4e7;margin:20px 0">
    <p style="font-size:12px;color:#94a3b8;margin:0;text-align:center">
      Máte dotazy? Napište nám na <a href="mailto:ahoj@toneracek.cz" style="color:#0891b2;text-decoration:none">ahoj@toneracek.cz</a>
    </p>
  </div>
</div>
</body>
</html>`;

  if (!process.env.RESEND_API_KEY) {
    console.log(`[DEV EMAIL] To: ${email} | Subject: Objednávka #${orderNumber} – ${config.subject}`);
    return;
  }

  const { error } = await resend.emails.send({
    from: FROM,
    to: [email],
    subject: `Objednávka #${orderNumber} – ${config.subject}`,
    html,
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
}

export async function sendInvoiceEmail({ invoice, issuer, email, pdfBuffer, subject, intro, from, paymentDetails }) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[DEV EMAIL] Invoice ${invoice.number} → ${email}`);
    return;
  }

  const emailFrom = from || (issuer.email
    ? `${issuer.name} <${issuer.email}>`
    : `one.seil.space <noreply@seil.cz>`);

  const emailSubject = subject || `Faktura ${invoice.number} — ${issuer.name}`;
  const emailIntro  = intro  || `v příloze zasíláme fakturu č. <strong>${invoice.number}</strong>.`;

  const paymentBlock = paymentDetails ? `
<div style="background:#f8f9fa;border-radius:8px;padding:16px 20px;margin:16px 0;">
  <p style="margin:0 0 8px;font-weight:600;">Platební údaje</p>
  ${paymentDetails.accountNumber ? `<p style="margin:2px 0;">Číslo účtu: <strong>${paymentDetails.accountNumber}</strong></p>` : ''}
  ${paymentDetails.iban ? `<p style="margin:2px 0;">IBAN: <strong>${paymentDetails.iban}</strong></p>` : ''}
  <p style="margin:2px 0;">Variabilní symbol: <strong>${paymentDetails.variableSymbol}</strong></p>
</div>` : '';

  const { error } = await resend.emails.send({
    from: emailFrom,
    to: [email],
    subject: emailSubject,
    html: `<p>Dobrý den,</p>
<p>${emailIntro}</p>
<p>Celková částka k úhradě: <strong>${Number(invoice.total_amount).toLocaleString('cs-CZ', {minimumFractionDigits:2})} ${invoice.currency || 'Kč'}</strong></p>
${invoice.due_date ? `<p>Splatnost: ${new Date(invoice.due_date).toLocaleDateString('cs-CZ')}</p>` : ''}
${paymentBlock}
<p>Děkujeme za spolupráci.</p>
<p>${issuer.name}</p>`,
    attachments: [{
      filename: `faktura-${invoice.number}.pdf`,
      content: Buffer.from(pdfBuffer).toString('base64'),
    }],
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
}
