import puppeteer from 'puppeteer';
import ejs from 'ejs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { invoiceVs } from './series-format.js';
import { qrPlatbaDataUri } from './qr-platba.js';
import { zobrazeniUhrady } from './danovy-doklad.js';
import { ceskeDatum } from './prazsky-cas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Candidate paths for system-installed Chromium on Linux VPS
const SYSTEM_CHROMIUM_PATHS = [
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
];

function findSystemChromium() {
  return SYSTEM_CHROMIUM_PATHS.find(p => existsSync(p)) ?? null;
}

let _browser = null;

async function getBrowser() {
  if (!_browser || !_browser.connected) {
    const executablePath = findSystemChromium();
    _browser = await puppeteer.launch({
      headless: true,
      executablePath: executablePath ?? undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
  }
  return _browser;
}

/**
 * HTML faktury — totéž, co jde do PDF, jen bez prohlížeče. Odděleně proto,
 * aby se obsah dokladu (razítko, platební instrukce, DUZP) dal otestovat bez
 * puppeteeru.
 *
 * `data.brand` vykreslí v záhlaví značku e-shopu místo vystavitele, `data.paid`
 * schová štítek „k úhradě" i platební instrukce. `data.paymentMethod` je způsob
 * platby objednávky — faktura ho sama nenese a bez něj by se dobírka tiskla
 * s číslem účtu a QR kódem jako doklad k převodu. Všechno je volitelné —
 * faktury mimo e-shop to nemají a vypadají jako dřív.
 *
 * `data.vs` přebije výchozí odvození z čísla dokladu. Používá ho zálohová
 * faktura k objednávce, která se platí pod číslem objednávky — PDF musí
 * tisknout tentýž symbol jako e-mail a QR kód, jinak jsme zpátky u tří
 * různých variabilních symbolů k jedné platbě.
 */
export async function renderInvoiceHtml(data) {
  const templatePath = path.join(projectRoot, 'views/pdf/invoice.ejs');
  // VS se počítá tady, aby ho měly stejný všechny cesty k PDF i e-mailu
  const vs = data.vs || invoiceVs(data.invoice?.number);

  const uhrada = zobrazeniUhrady({
    invoice: data.invoice, paid: data.paid, paymentMethod: data.paymentMethod,
  });

  // QR jen na dokladu, který se platí převodem. Na zaplacené faktuře ani na
  // dobírce nemá co dělat — mizí i platební instrukce, do kterých patří.
  const qrDataUri = uhrada.instrukce ? await qrPlatbaDataUri({
    iban: data.issuer?.iban,
    amount: data.invoice?.total_amount,
    currency: data.invoice?.currency || 'CZK',
    variableSymbol: vs,
    message: `${data.invoice?.type === 'proforma' ? 'Zálohová faktura' : 'Faktura'} ${data.invoice?.number ?? ''}`.trim(),
  }) : null;

  return ejs.renderFile(templatePath, {
    brand: null,
    ...data,
    vs,
    qrDataUri,
    uhrada,
    ceskeDatum,
  });
}

/** PDF faktury. Parametry viz renderInvoiceHtml(). */
export async function renderInvoicePdf(data) {
  const html = await renderInvoiceHtml(data);

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // Pozor: 'networkidle0' se u setContent() nikdy nespustí (šablona nedělá
    // žádný síťový požadavek) a render spadne na 30s timeout.
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({
      format: 'A4',
      margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' },
      printBackground: true,
    });
    return pdf;
  } finally {
    await page.close();
  }
}

export async function closeBrowser() {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}
