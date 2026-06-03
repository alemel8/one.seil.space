import puppeteer from 'puppeteer';
import ejs from 'ejs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

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
