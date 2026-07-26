// Generátor POHODA XML datového balíčku (formát STORMWARE)
// https://www.stormware.cz/xml/

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

// Vydaná nebo přijatá faktura → POHODA XML element
function invoiceToXml(inv, items = [], idx = 1) {
  const type = inv.type === 'issued' ? 'issuedInvoice' : 'receivedInvoice';
  const partnerName = inv.type === 'issued' ? (inv.client_name || '') : (inv.supplier || '');
  const partnerIco  = inv.type === 'issued' ? (inv.client_ico  || '') : (inv.supplier_ico || '');
  const issueDate   = fmtDate(inv.issue_date);

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

  const itemsXml = items.length > 0
    ? items.map(it => itemXml(
        it.name || it.description || 'Položka',
        it.quantity,
        it.unit_price || it.amount,
        it.amount,
        it.vat_amount,
        // sazba na položce je uložena v procentech
        !Number(it.vat_rate) ? 'none' : (Number(it.vat_rate) <= 15 ? 'low' : 'high'),
      )).join('')
    : itemXml(inv.notes || 'Plnění dle faktury', 1, inv.amount, inv.amount, inv.vat_amount,
        vatRate(inv.amount, inv.vat_amount));

  // Rozpad částek podle sazeb DPH — POHODA jinak dopočte DPH sama a součty nesedí
  const s = { none: 0, low: 0, lowVAT: 0, high: 0, highVAT: 0 };
  if (items.length > 0) {
    for (const it of items) {
      const r = !Number(it.vat_rate) ? 'none' : (Number(it.vat_rate) <= 15 ? 'low' : 'high');
      s[r] += Number(it.amount || 0);
      if (r !== 'none') s[r + 'VAT'] += Number(it.vat_amount || 0);
    }
  } else {
    const r = vatRate(inv.amount, inv.vat_amount);
    if (r === 'none') s.none = Number(inv.total_amount || inv.amount || 0);
    else { s[r] = Number(inv.amount || 0); s[r + 'VAT'] = Number(inv.vat_amount || 0); }
  }
  const round = Number(inv.total_amount || 0) - (s.none + s.low + s.lowVAT + s.high + s.highVAT);

  const sumXml = [
    s.none          ? `\n          <typ:priceNone>${fmtNum(s.none)}</typ:priceNone>` : '',
    s.low || s.lowVAT ? `\n          <typ:priceLow>${fmtNum(s.low)}</typ:priceLow>`
                      + `\n          <typ:priceLowVAT>${fmtNum(s.lowVAT)}</typ:priceLowVAT>` : '',
    s.high || s.highVAT ? `\n          <typ:priceHigh>${fmtNum(s.high)}</typ:priceHigh>`
                        + `\n          <typ:priceHighVAT>${fmtNum(s.highVAT)}</typ:priceHighVAT>` : '',
    `\n          <typ:round><typ:priceRound>${fmtNum(round)}</typ:priceRound></typ:round>`,
  ].join('');

  return `  <dat:dataPackItem id="${idx}" version="2.0">
    <inv:invoice version="2.0">
      <inv:invoiceHeader>
        <inv:invoiceType>${type}</inv:invoiceType>
        <inv:number>
          <typ:numberRequested>${esc(inv.number)}</typ:numberRequested>
        </inv:number>
        <inv:symVar>${esc(inv.number)}</inv:symVar>
        ${issueDate ? `<inv:date>${issueDate}</inv:date>` : ''}
        ${(fmtDate(inv.due_date) || issueDate) ? `<inv:dateDue>${fmtDate(inv.due_date) || issueDate}</inv:dateDue>` : ''}
        ${issueDate ? `<inv:dateTax>${issueDate}</inv:dateTax>` : ''}
        <inv:text>${esc(inv.notes || '')}</inv:text>
        <inv:partnerIdentity>
          <typ:address>
            <typ:company>${esc(partnerName)}</typ:company>${partnerIco ? `
            <typ:ico>${esc(partnerIco)}</typ:ico>` : ''}${inv.type === 'received' && inv.supplier_dic ? `
            <typ:dic>${esc(inv.supplier_dic)}</typ:dic>` : ''}${inv.type === 'received' && inv.supplier_address ? `
            <typ:street>${esc(inv.supplier_address)}</typ:street>` : ''}${inv.type === 'received' && inv.supplier_city ? `
            <typ:city>${esc(inv.supplier_city)}</typ:city>` : ''}${inv.type === 'received' && inv.supplier_zip ? `
            <typ:zip>${esc(inv.supplier_zip)}</typ:zip>` : ''}
          </typ:address>
        </inv:partnerIdentity>
        <inv:paymentType>
          <typ:paymentType>draft</typ:paymentType>
        </inv:paymentType>${inv.account_debit ? `
        <inv:accounting>
          <typ:ids>${esc(trunc(inv.account_debit, 20))}</typ:ids>
        </inv:accounting>` : ''}
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

// Účtenka → POHODA XML element (agenda Pokladna → výdajový pokladní doklad)
//
// Pozn.: evidenční číslo dokladu (vou:number) se nepředává — POHODA jej přidělí
// z číselné řady zvolené pokladny, jinak import padá na neshodě s řadou.
// Číslo účtenky jde do originalDocument = „číslo paragonu“.
function receiptToXml(r, idx = 1, opts = {}) {
  const base   = Number(r.amount || 0);
  const vat    = Number(r.vat_amount || 0);
  const total  = (r.total_amount === null || r.total_amount === undefined || r.total_amount === '')
    ? base + vat
    : Number(r.total_amount);
  const rate   = vatRate(base, vat);
  const date   = fmtDate(r.receipt_date);

  // Text dokladu: dodavatel + poznámka
  const text = trunc([r.vendor || null, r.notes || null].filter(Boolean).join(' — ')
    || 'Účtenka', 240);

  // Rozpad částky podle sazby DPH; rozdíl proti celkové částce (zaokrouhlení
  // na paragonu) jde do priceRound, jinak by POHODA hlásila neshodu součtu
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
        <vou:date>${date}</vou:date>` : ''}${date && rate !== 'none' ? `
        <vou:dateTax>${date}</vou:dateTax>` : ''}${opts.predkontace ? `
        <vou:accounting>
          <typ:ids>${esc(trunc(opts.predkontace, 20))}</typ:ids>
        </vou:accounting>` : ''}
        <vou:text>${esc(text)}</vou:text>${r.vendor ? `
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

// opts.ico          — IČO účetní jednotky, do které se import provede (povinné,
//                     jinak POHODA balíček odmítne — nenajde účetní jednotku)
// opts.cashAccount  — název pokladny v POHODĚ (pro účtenky)
// opts.predkontace  — předkontace přiřazená importovaným účtenkám
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
    if (item._type === 'receipt') return receiptToXml(item, i + 1, opts);
    return invoiceToXml(item, item._items || [], i + 1);
  }).join('\n');

  return header + '\n' + body + '\n</dat:dataPack>';
}
