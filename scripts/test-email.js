/**
 * Ověření odesílání e-mailů — zkontroluje konfiguraci a pošle testovací zprávu.
 *
 * V produkci (Coolify terminál), kde jsou proměnné už v prostředí:
 *   node scripts/test-email.js ales@seil.cz
 *
 * Lokálně:
 *   node --env-file=.env scripts/test-email.js ales@seil.cz
 *
 * Bez adresy jen vypíše, jak je odesílání nastavené, a nic neodešle.
 */

import { Resend } from 'resend';

const to = process.argv[2];

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM      = process.env.MAIL_FROM || '';
const MAIL_REPLY_TO  = process.env.MAIL_REPLY_TO || '';

// "Jméno <adresa@domena>" nebo holé "adresa@domena"
const FROM_RE = /^(?:[^<>]+<\s*[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+\s*>|[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+)$/;

function mask(v) {
  if (!v) return '(nenastaveno)';
  return v.length <= 10 ? '(nastaveno)' : `${v.slice(0, 6)}…${v.slice(-4)}`;
}

function senderDomain(from) {
  return from.match(/<\s*[^@\s<>]+@([^@\s<>]+)\s*>|[^@\s<>]+@([^@\s<>]+)/)?.slice(1).find(Boolean) ?? '';
}

console.log('=== Konfigurace odesílání ===');
console.log(`RESEND_API_KEY  ${mask(RESEND_API_KEY)}`);
console.log(`MAIL_FROM       ${MAIL_FROM || '(nenastaveno → použije se "SEIL s.r.o. <noreply@seil.cz>")'}`);
console.log(`MAIL_REPLY_TO   ${MAIL_REPLY_TO || '(nenastaveno → použije se e-mail z nastavení firmy)'}`);

const problems = [];
if (!RESEND_API_KEY)                     problems.push('RESEND_API_KEY není nastaven — e-maily se jen logují do konzole.');
else if (!RESEND_API_KEY.startsWith('re_')) problems.push('RESEND_API_KEY nevypadá jako klíč Resendu (má začínat "re_").');
else if (/X{3,}/.test(RESEND_API_KEY))   problems.push('RESEND_API_KEY je pořád zástupná hodnota z .env.example.');

if (MAIL_FROM && !FROM_RE.test(MAIL_FROM)) {
  problems.push(`MAIL_FROM není platná adresa: "${MAIL_FROM}". Očekává se "Jméno <adresa@domena>".`);
}

if (problems.length) {
  console.log('\n⚠  Problémy:');
  for (const p of problems) console.log(`   • ${p}`);
} else {
  console.log('\n✓ Konfigurace vypadá v pořádku.');
}

const effectiveFrom = MAIL_FROM || 'SEIL s.r.o. <noreply@seil.cz>';
console.log(`\nOdesílatel:  ${effectiveFrom}`);
console.log(`Doména:      ${senderDomain(effectiveFrom)} — musí být ověřená v Resendu`);

if (!to) {
  console.log('\nPro odeslání testovací zprávy přidej adresu:');
  console.log('   node scripts/test-email.js tvuj@email.cz');
  process.exit(problems.length ? 1 : 0);
}

if (!RESEND_API_KEY || problems.length) {
  console.error('\n❌ Neodesílám — nejdřív oprav problémy výše.');
  process.exit(1);
}

console.log(`\nOdesílám testovací zprávu na ${to} …`);

const { data, error } = await new Resend(RESEND_API_KEY).emails.send({
  from: effectiveFrom,
  replyTo: MAIL_REPLY_TO || undefined,
  to: [to],
  subject: 'Test odesílání — one.seil.space',
  html: `<p>Tohle je testovací zpráva z one.seil.space.</p>
<p>Odesílatel: <strong>${effectiveFrom}</strong><br>
Odpovědi směřují na: <strong>${MAIL_REPLY_TO || '(nenastaveno)'}</strong></p>
<p>Když ti dorazila, odesílání faktur i upomínek je funkční.</p>`,
});

if (error) {
  console.error('\n❌ Resend odmítl zprávu:', error.message);
  if (/domain|verif/i.test(error.message)) {
    console.error(`   Zkontroluj, že doména ${senderDomain(effectiveFrom)} je v Resendu ověřená.`);
  }
  process.exit(1);
}

console.log(`\n✓ Odesláno. Resend id: ${data?.id}`);
console.log('  Zkontroluj schránku — a zkus na zprávu odpovědět, jestli odpověď dorazí na reply-to adresu.');
