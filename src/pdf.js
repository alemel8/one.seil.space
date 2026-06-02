// Generování PDF z EJS šablony přes Puppeteer
import puppeteer from 'puppeteer';
import ejs from 'ejs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

let _browser = null;

async function getBrowser() {
  if (!_browser || !_browser.connected) {
    _browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
  }
  return _browser;
}

export async function renderInvoicePdf(data) {
  const templatePath = path.join(projectRoot, 'views/pdf/invoice.ejs');
  const html = await ejs.renderFile(templatePath, data);

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
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
