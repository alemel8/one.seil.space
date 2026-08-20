// Generátor POHODA XML datového balíčku (formát STORMWARE)
// https://www.stormware.cz/xml/
//
// Doklad → agenda v POHODĚ:
//   vydaná faktura              → Vydané faktury        (issuedInvoice)
//   přijatá faktura             → Přijaté faktury       (receivedInvoice)
//   účtenka placená hotově      → Pokladna, výdaj       (voucher/expense)
//   účtenka placená kartou/převodem → Ostatní závazky   (commitment)
//
// Poslední řádek je požadavek účetní: co je hrazené kartou z účtu, nemá
// v pokladně co dělat — patří mezi ostatní závazky a spáruje se s výpisem.

import { invoiceVs } from './series-format.js';

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(d) {
  if (!d) return '';
  // Řetězec YYYY-MM-DD bereme rovnou, ať se datum neposune přes časovou zónu
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return '';
  return dt.toISOString().slice(0, 10);
}

function fmtNum(n) {
  const v = Number(n || 0).toFixed(2);
  return v === '-0.00' ? '0.00' : v; // POHODA zápornou nulu neakceptuje
}

// POHODA validuje délky řetězců podle XSD — delší hodnota shodí celý import
function trunc(str, max) {
  const s = String(str || '');
  return s.length > max ? s.slice(0, max) : s;
}

// Sazba DPH podle poměru DPH k základu → POHODA rozlišuje none / low / high
function vatRate(base, vat) {
  const b = Number(base || 0);
  const v = Number(vat  || 0);
  if (!v || !b) return 'none';
  return (v / b) * 100 <= 15 ? 'low' : 'high';
}

function rateOfItem(it) {
  return !Number(it.vat_rate) ? 'none' : (Number(it.vat_rate) <= 15 ? 'low' : 'high');
}

// Reprezentace a spol. nárok na odpočet DPH nemají (§ 72 odst. 4 ZDPH).
// Sloupec je NOT NULL DEFAULT TRUE, takže odpočet padá jen na výslovné false.
export function isVatDeductible(doc) {
  return doc?.vat_deductible !== false;
}

// ── Účtenky: forma úhrady ────────────────────────────────────

export const PAYMENT_METHODS = ['Hotovost', 'Karta', 'Převodem'];

export function isCashReceipt(r) {
  return !r?.payment_method || r.payment_method === 'Hotovost';
}

// Do jaké agendy POHODY účtenka spadne — používá i seznam účtenek,
// aby uživatel dopředu věděl, co mu z exportu vypadne.
export function receiptAgenda(r) {
  return isCashReceipt(r) ? 'Pokladna' : 'Ostatní závazky';
}

// Země se v POHODĚ tahá z číselníku podle ISO kódu; tuzemsko je výchozí,
// takže ho neposíláme vůbec a u zbytku vystačíme s tím, co reálně padá z ARESu.
const COUNTRY_IDS = {
  'ceska republika': null, 'cesko': null, 'cz': null,
  'slovensko': 'SK', 'slovenska republika': 'SK', 'sk': 'SK',
  'nemecko': 'DE', 'de': 'DE',
  'polsko': 'PL', 'pl': 'PL',
  'rakousko': 'AT', 'at': 'AT',
};

function countryIds(name) {
  const key = String(name || '')
    .toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').trim();
  if (!key) return null;
  if (key in COUNTRY_IDS) return COUNTRY_IDS[key];
  return /^[a-z]{2}$/.test(key) ? key.toUpperCase() : null;
}

// Variabilní symbol: jen číslice, nejvýše 10 znaků (limit bank i pro příkaz,
// který POHODA z přijaté faktury vystaví). Podřetězec čísla dokladu zůstává.
//
// Z čísel jako „B2“ nebo „A/7“ by vypadl jednociferný symbol, na který by se
// v bance nabalila cizí platba — pod čtyři číslice radši VS neposíláme vůbec.
function symVar(number) {
  const vs = invoiceVs(number);
  return vs.length >= 4 ? vs : '';
}

// Předkontace dokladu: bez nároku na odpočet má vlastní (typicky 513 Repre),
// jinak platí předkontace z dokladu a nakonec výchozí z nastavení.
function predkontaceOf(doc, deductible, opts, fallbackKey) {
  if (!deductible && opts.predkontaceNoVat) return opts.predkontaceNoVat;
  return doc.account_debit || opts[fallbackKey] || '';
}

// Členění DPH — výchozí „inland“ posílat nemusíme, zajímá nás jen doklad
// bez nároku na odpočet, který se do přiznání nemá dostat vůbec.
function classificationVatXml(ns, deductible, indent) {
  if (deductible) return '';
  return `\n${indent}<${ns}:classificationVAT>`
       + `\n${indent}  <typ:classificationVATType>nonSubsume</typ:classificationVATType>`
       + `\n${indent}</${ns}:classificationVAT>`;
}

// ── Faktura (vydaná i přijatá) → POHODA XML ──────────────────
//
// Pozn.: u přijaté faktury evidenční číslo nepředáváme — přiděluje ho POHODA
// z vlastní číselné řady. Dodavatelovo číslo jde do originalDocument („Doklad")
// a jeho číslice do variabilního symbolu, ať jde platba spárovat. Kdybychom ho
// poslali jako numberRequested, import padá na duplicitě s cizí řadou.
function invoiceToXml(inv, items = [], idx = 1, opts = {}) {
  const issued      = inv.type === 'issued';
  const type        = issued ? 'issuedInvoice' : 'receivedInvoice';
  const partnerName = issued ? (inv.client_name || '') : (inv.supplier || '');
  const partnerIco  = issued ? (inv.client_ico  || '') : (inv.supplier_ico || '');
  const issueDate   = fmtDate(inv.issue_date);
  const deductible  = issued || isVatDeductible(inv);
  const vs          = symVar(inv.number);
  const country     = issued ? null : countryIds(inv.supplier_country);
  const predkontace = predkontaceOf(inv, deductible, opts,
    issued ? 'predkontaceIssued' : 'predkontaceReceived');
  const total = Number(inv.total_amount || 0)
    || Number(inv.amount || 0) + Number(inv.vat_amount || 0);

  const itemXml = (text, quantity, unitPrice, base, vat, rate) => `
        <inv:invoiceItem>
          <inv:text>${esc(trunc(text, 90))}</inv:text>
          <inv:quantity>${Number(quantity || 1).toFixed(2)}</inv:quantity>
          <inv:unit>ks</inv:unit>
          <inv:payVAT>false</inv:payVAT>
          <inv:rateVAT>${rate}</inv:rateVAT>
          <inv:homeCurrency>
            <typ:unitPrice>${fmtNum(unitPrice)}</typ:unitPrice>
            <typ:price>${fmtNum(base)}</typ:price>
            <typ:priceVAT>${fmtNum(vat)}</typ:priceVAT>
          </inv:homeCurrency>
        </inv:invoiceItem>`;

  const fallbackText = inv.notes
    || (issued ? 'Plnění dle faktury' : `Přijatá faktura ${inv.number || ''}`.trim());

  // Bez nároku na odpočet jde na doklad jediná položka v plné výši včetně DPH —
  // rozpad podle sazeb by POHODU navedl na odpočet, který u repre nelze.
  const itemsXml = !deductible
    ? itemXml(fallbackText, 1, total, total, 0, 'none')
    : items.length > 0
      ? items.map(it => itemXml(
          it.name || it.description || 'Položka',
          it.quantity,
          it.unit_price || it.amount,
          it.amount,
          it.vat_amount,
          rateOfItem(it),
        )).join('')
      : itemXml(fallbackText, 1, inv.amount, inv.amount, inv.vat_amount,
          vatRate(inv.amount, inv.vat_amount));

  // Rozpad částek podle sazeb DPH — POHODA jinak dopočte DPH sama a součty nesedí
  const s = { none: 0, low: 0, lowVAT: 0, high: 0, highVAT: 0 };
  if (!deductible) {
    s.none = total;
  } else if (items.length > 0) {
    for (const it of items) {
      const r = rateOfItem(it);
      s[r] += Number(it.amount || 0);
      if (r !== 'none') s[r + 'VAT'] += Number(it.vat_amount || 0);
    }
  } else {
    const r = vatRate(inv.amount, inv.vat_amount);
    if (r === 'none') s.none = total;
    else { s[r] = Number(inv.amount || 0); s[r + 'VAT'] = Number(inv.vat_amount || 0); }
  }
  const round = total - (s.none + s.low + s.lowVAT + s.high + s.highVAT);

  const sumXml = [
    s.none          ? `\n          <typ:priceNone>${fmtNum(s.none)}</typ:priceNone>` : '',
    s.low || s.lowVAT ? `\n          <typ:priceLow>${fmtNum(s.low)}</typ:priceLow>`
                      + `\n          <typ:priceLowVAT>${fmtNum(s.lowVAT)}</typ:priceLowVAT>` : '',
    s.high || s.highVAT ? `\n          <typ:priceHigh>${fmtNum(s.high)}</typ:priceHigh>`
                        + `\n          <typ:priceHighVAT>${fmtNum(s.highVAT)}</typ:priceHighVAT>` : '',
    `\n          <typ:round><typ:priceRound>${fmtNum(round)}</typ:priceRound></typ:round>`,
  ].join('');

  return `  <dat:dataPackItem id="${esc(trunc(String(inv.id || idx), 32))}" version="2.0">
    <inv:invoice version="2.0">
      <inv:invoiceHeader>
        <inv:invoiceType>${type}</inv:invoiceType>${issued ? `
        <inv:number>
          <typ:numberRequested>${esc(trunc(inv.number, 32))}</typ:numberRequested>
        </inv:number>` : ''}${vs ? `
        <inv:symVar>${esc(vs)}</inv:symVar>` : ''}${!issued && inv.number ? `
        <inv:originalDocument>${esc(trunc(inv.number, 32))}</inv:originalDocument>` : ''}${issueDate ? `
        <inv:date>${issueDate}</inv:date>` : ''}${issueDate && deductible ? `
        <inv:dateTax>${issueDate}</inv:dateTax>` : ''}${issueDate ? `
        <inv:dateAccounting>${issueDate}</inv:dateAccounting>` : ''}${(fmtDate(inv.due_date) || issueDate) ? `
        <inv:dateDue>${fmtDate(inv.due_date) || issueDate}</inv:dateDue>` : ''}${predkontace ? `
        <inv:accounting>
          <typ:ids>${esc(trunc(predkontace, 20))}</typ:ids>
        </inv:accounting>` : ''}${classificationVatXml('inv', deductible, '        ')}
        <inv:text>${esc(trunc(inv.notes || fallbackText, 240))}</inv:text>
        <inv:partnerIdentity>
          <typ:address>
            <typ:company>${esc(trunc(partnerName, 255))}</typ:company>${partnerIco ? `
            <typ:ico>${esc(trunc(partnerIco, 15))}</typ:ico>` : ''}${!issued && inv.supplier_dic ? `
            <typ:dic>${esc(trunc(inv.supplier_dic, 18))}</typ:dic>` : ''}${!issued && inv.supplier_address ? `
            <typ:street>${esc(trunc(inv.supplier_address, 64))}</typ:street>` : ''}${!issued && inv.supplier_city ? `
            <typ:city>${esc(trunc(inv.supplier_city, 45))}</typ:city>` : ''}${!issued && inv.supplier_zip ? `
            <typ:zip>${esc(trunc(inv.supplier_zip, 15))}</typ:zip>` : ''}${country ? `
            <typ:country>
              <typ:ids>${esc(country)}</typ:ids>
            </typ:country>` : ''}
          </typ:address>
        </inv:partnerIdentity>
        <inv:paymentType>
          <typ:paymentType>draft</typ:paymentType>
        </inv:paymentType>
      </inv:invoiceHeader>
      <inv:invoiceDetail>${itemsXml}
      </inv:invoiceDetail>
      <inv:invoiceSummary>
        <inv:roundingDocument>none</inv:roundingDocument>
        <inv:homeCurrency>${sumXml}
        </inv:homeCurrency>${(inv.currency && inv.currency !== 'CZK') ? `
        <inv:foreignCurrency>
          <typ:currency>
            <typ:ids>${esc(inv.currency)}</typ:ids>
          </typ:currency>
        </inv:foreignCurrency>` : ''}
      </inv:invoiceSummary>
    </inv:invoice>
  </dat:dataPackItem>`;
}

// Částky účtenky — celková částka může nést zaokrouhlení paragonu
function receiptAmounts(r) {
  const base  = Number(r.amount || 0);
  const vat   = Number(r.vat_amount || 0);
  const total = (r.total_amount === null || r.total_amount === undefined || r.total_amount === '')
    ? base + vat
    : Number(r.total_amount);
  const deductible = isVatDeductible(r);
  return { base, vat, total, deductible, rate: deductible ? vatRate(base, vat) : 'none' };
}

// Text dokladu: dodavatel + poznámka
function receiptText(r) {
  return trunc([r.vendor || null, r.notes || null].filter(Boolean).join(' — ') || 'Účtenka', 240);
}

// Účtenka placená hotově → agenda Pokladna, výdajový pokladní doklad
//
// Pozn.: evidenční číslo dokladu (vou:number) se nepředává — POHODA jej přidělí
// z číselné řady zvolené pokladny, jinak import padá na neshodě s řadou.
// Číslo účtenky jde do originalDocument = „číslo paragonu“.
function receiptToXml(r, idx = 1, opts = {}) {
  const { base, vat, total, deductible, rate } = receiptAmounts(r);
  const date = fmtDate(r.receipt_date);
  const predkontace = predkontaceOf(r, deductible, opts, 'predkontace');

  // Rozpad částky podle sazby DPH; rozdíl proti celkové částce (zaokrouhlení
  // na paragonu) jde do priceRound, jinak by POHODA hlásila neshodu součtu.
  // Bez nároku na odpočet je nákladem celá částka včetně DPH.
  const homeCurrency = rate === 'none'
    ? `
          <typ:priceNone>${fmtNum(total)}</typ:priceNone>`
    : (() => {
        const b = rate === 'low' ? 'Low' : 'High';
        return `
          <typ:price${b}>${fmtNum(base)}</typ:price${b}>
          <typ:price${b}VAT>${fmtNum(vat)}</typ:price${b}VAT>
          <typ:round><typ:priceRound>${fmtNum(total - base - vat)}</typ:priceRound></typ:round>`;
      })();

  return `  <dat:dataPackItem id="uctenka-${r.id || idx}" version="2.0">
    <vou:voucher version="2.0">
      <vou:voucherHeader>
        <vou:voucherType>expense</vou:voucherType>
        <vou:cashAccount>
          <typ:ids>${esc(trunc(opts.cashAccount || 'Pokladna', 20))}</typ:ids>
        </vou:cashAccount>${r.number ? `
        <vou:originalDocument>${esc(trunc(r.number, 32))}</vou:originalDocument>` : ''}${date ? `
        <vou:date>${date}</vou:date>` : ''}${date && deductible && rate !== 'none' ? `
        <vou:dateTax>${date}</vou:dateTax>` : ''}${predkontace ? `
        <vou:accounting>
          <typ:ids>${esc(trunc(predkontace, 20))}</typ:ids>
        </vou:accounting>` : ''}${classificationVatXml('vou', deductible, '        ')}
        <vou:text>${esc(receiptText(r))}</vou:text>${r.vendor ? `
        <vou:partnerIdentity>
          <typ:address>
            <typ:company>${esc(trunc(r.vendor, 96))}</typ:company>${r.vendor_ico ? `
            <typ:ico>${esc(trunc(r.vendor_ico, 15))}</typ:ico>` : ''}
          </typ:address>
        </vou:partnerIdentity>` : ''}
      </vou:voucherHeader>
      <vou:voucherSummary>
        <vou:homeCurrency>${homeCurrency}
        </vou:homeCurrency>
      </vou:voucherSummary>
    </vou:voucher>
  </dat:dataPackItem>`;
}

// Účtenka placená kartou nebo převodem → agenda Ostatní závazky
//
// Z pokladny takový doklad účetní stejně vyhazuje: peníze odešly z účtu.
// Jako závazek se v POHODĚ spáruje s řádkem bankovního výpisu.
function receiptToCommitmentXml(r, idx = 1, opts = {}) {
  const { base, vat, total, deductible, rate } = receiptAmounts(r);
  const date = fmtDate(r.receipt_date);
  const vs   = symVar(r.number);
  const text = receiptText(r);
  const predkontace = predkontaceOf(r, deductible, opts, 'predkontaceReceived');
  const payment = r.payment_method === 'Karta' ? 'creditcard' : 'draft';

  const itemBase = rate === 'none' ? total : base;
  const itemVat  = rate === 'none' ? 0     : vat;

  const sumXml = rate === 'none'
    ? `\n          <typ:priceNone>${fmtNum(total)}</typ:priceNone>`
      + `\n          <typ:round><typ:priceRound>0.00</typ:priceRound></typ:round>`
    : (() => {
        const b = rate === 'low' ? 'Low' : 'High';
        return `\n          <typ:price${b}>${fmtNum(base)}</typ:price${b}>`
             + `\n          <typ:price${b}VAT>${fmtNum(vat)}</typ:price${b}VAT>`
             + `\n          <typ:round><typ:priceRound>${fmtNum(total - base - vat)}</typ:priceRound></typ:round>`;
      })();

  return `  <dat:dataPackItem id="zavazek-${r.id || idx}" version="2.0">
    <inv:invoice version="2.0">
      <inv:invoiceHeader>
        <inv:invoiceType>commitment</inv:invoiceType>${vs ? `
        <inv:symVar>${esc(vs)}</inv:symVar>` : ''}${r.number ? `
        <inv:originalDocument>${esc(trunc(r.number, 32))}</inv:originalDocument>` : ''}${date ? `
        <inv:date>${date}</inv:date>` : ''}${date && deductible && rate !== 'none' ? `
        <inv:dateTax>${date}</inv:dateTax>` : ''}${date ? `
        <inv:dateAccounting>${date}</inv:dateAccounting>
        <inv:dateDue>${date}</inv:dateDue>` : ''}${predkontace ? `
        <inv:accounting>
          <typ:ids>${esc(trunc(predkontace, 20))}</typ:ids>
        </inv:accounting>` : ''}${classificationVatXml('inv', deductible, '        ')}
        <inv:text>${esc(text)}</inv:text>${r.vendor ? `
        <inv:partnerIdentity>
          <typ:address>
            <typ:company>${esc(trunc(r.vendor, 255))}</typ:company>${r.vendor_ico ? `
            <typ:ico>${esc(trunc(r.vendor_ico, 15))}</typ:ico>` : ''}
          </typ:address>
        </inv:partnerIdentity>` : ''}
        <inv:paymentType>
          <typ:paymentType>${payment}</typ:paymentType>
        </inv:paymentType>
      </inv:invoiceHeader>
      <inv:invoiceDetail>
        <inv:invoiceItem>
          <inv:text>${esc(trunc(text, 90))}</inv:text>
          <inv:quantity>1.00</inv:quantity>
          <inv:unit>ks</inv:unit>
          <inv:payVAT>false</inv:payVAT>
          <inv:rateVAT>${rate}</inv:rateVAT>
          <inv:homeCurrency>
            <typ:unitPrice>${fmtNum(itemBase)}</typ:unitPrice>
            <typ:price>${fmtNum(itemBase)}</typ:price>
            <typ:priceVAT>${fmtNum(itemVat)}</typ:priceVAT>
          </inv:homeCurrency>
        </inv:invoiceItem>
      </inv:invoiceDetail>
      <inv:invoiceSummary>
        <inv:roundingDocument>none</inv:roundingDocument>
        <inv:homeCurrency>${sumXml}
        </inv:homeCurrency>
      </inv:invoiceSummary>
    </inv:invoice>
  </dat:dataPackItem>`;
}

// opts.ico                 — IČO účetní jednotky, do které se import provede
//                            (povinné, jinak POHODA balíček odmítne)
// opts.cashAccount         — název pokladny v POHODĚ (účtenky placené hotově)
// opts.predkontace         — předkontace účtenek v pokladně
// opts.predkontaceReceived — předkontace přijatých faktur a ostatních závazků
// opts.predkontaceIssued   — předkontace vydaných faktur
// opts.predkontaceNoVat    — předkontace dokladů bez nároku na odpočet (repre)
export function buildPohodaXml(items, opts = {}) {
  const header = `<?xml version="1.0" encoding="UTF-8"?>
<dat:dataPack
  xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
  xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd"
  xmlns:vou="http://www.stormware.cz/schema/version_2/voucher.xsd"
  xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd"
  id="${esc(trunc(opts.id || 'one-seil-space', 64))}"${opts.ico ? `
  ico="${esc(String(opts.ico).replace(/\s/g, ''))}"` : ''}
  application="one.seil.space" version="2.0"
  note="${esc(trunc(opts.note || 'Export z one.seil.space', 200))}">`;

  const body = items.map((item, i) => {
    if (item._type === 'receipt') {
      return isCashReceipt(item)
        ? receiptToXml(item, i + 1, opts)
        : receiptToCommitmentXml(item, i + 1, opts);
    }
    return invoiceToXml(item, item._items || [], i + 1, opts);
  }).join('\n');

  return header + '\n' + body + '\n</dat:dataPack>';
}
