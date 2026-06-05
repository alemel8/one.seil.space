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
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return '';
  return dt.toISOString().slice(0, 10);
}

function fmtNum(n) {
  return Number(n || 0).toFixed(2);
}

// Vydaná nebo přijatá faktura → POHODA XML element
function invoiceToXml(inv, items = [], idx = 1) {
  const type = inv.type === 'issued' ? 'issuedInvoice' : 'receivedInvoice';
  const partnerName = inv.type === 'issued' ? (inv.client_name || '') : (inv.supplier || '');
  const partnerIco  = inv.type === 'issued' ? (inv.client_ico  || '') : (inv.supplier_ico || '');

  const itemsXml = items.length > 0
    ? items.map(it => `
        <inv:invoiceItem>
          <inv:text>${esc(it.name || it.description || 'Položka')}</inv:text>
          <inv:quantity>${Number(it.quantity || 1).toFixed(2)}</inv:quantity>
          <inv:unit>ks</inv:unit>
          <inv:homeCurrency>
            <typ:unitPrice>${fmtNum(it.unit_price || it.amount)}</typ:unitPrice>
            <typ:price>${fmtNum(it.amount)}</typ:price>
            <typ:priceVAT>${fmtNum(it.vat_amount)}</typ:priceVAT>
            <typ:priceSumVAT>${fmtNum((Number(it.amount||0)) + (Number(it.vat_amount||0)))}</typ:priceSumVAT>
          </inv:homeCurrency>
          <inv:vatRate>${Number(it.vat_rate || 21)}%</inv:vatRate>
        </inv:invoiceItem>`).join('')
    : `
        <inv:invoiceItem>
          <inv:text>${esc(inv.notes || 'Plnění dle faktury')}</inv:text>
          <inv:quantity>1.00</inv:quantity>
          <inv:unit>ks</inv:unit>
          <inv:homeCurrency>
            <typ:unitPrice>${fmtNum(inv.amount)}</typ:unitPrice>
            <typ:price>${fmtNum(inv.amount)}</typ:price>
            <typ:priceVAT>${fmtNum(inv.vat_amount)}</typ:priceVAT>
            <typ:priceSumVAT>${fmtNum(inv.total_amount)}</typ:priceSumVAT>
          </inv:homeCurrency>
          <inv:vatRate>21%</inv:vatRate>
        </inv:invoiceItem>`;

  return `  <dat:dataPackItem id="${idx}" version="2.0">
    <inv:invoice version="2.0">
      <inv:invoiceHeader>
        <inv:invoiceType>${type}</inv:invoiceType>
        <inv:number>
          <typ:numberRequested>${esc(inv.number)}</typ:numberRequested>
        </inv:number>
        <inv:symVar>${esc(inv.number)}</inv:symVar>
        <inv:date>${fmtDate(inv.issue_date)}</inv:date>
        <inv:dateDue>${fmtDate(inv.due_date) || fmtDate(inv.issue_date)}</inv:dateDue>
        <inv:dateKVDPH>${fmtDate(inv.issue_date)}</inv:dateKVDPH>
        <inv:text>${esc(inv.notes || '')}</inv:text>
        <inv:partnerIdentity>
          <typ:address>
            <typ:company>${esc(partnerName)}</typ:company>
            ${partnerIco ? `<typ:ico>${esc(partnerIco)}</typ:ico>` : ''}
            ${inv.type === 'received' && inv.supplier_dic     ? `<typ:dic>${esc(inv.supplier_dic)}</typ:dic>` : ''}
            ${inv.type === 'received' && inv.supplier_address ? `<typ:street>${esc(inv.supplier_address)}</typ:street>` : ''}
            ${inv.type === 'received' && inv.supplier_city    ? `<typ:city>${esc(inv.supplier_city)}</typ:city>` : ''}
            ${inv.type === 'received' && inv.supplier_zip     ? `<typ:zip>${esc(inv.supplier_zip)}</typ:zip>` : ''}
          </typ:address>
        </inv:partnerIdentity>
        <inv:paymentType>
          <typ:paymentType>transfer</typ:paymentType>
        </inv:paymentType>
        <inv:account>
          <typ:accountNo/>
          <typ:bankCode/>
        </inv:account>
        ${inv.account_debit  ? `<inv:accounting><typ:accountingMD><typ:ids>${esc(inv.account_debit)}</typ:ids></typ:accountingMD></inv:accounting>` : ''}
        ${inv.account_credit ? `<inv:classificationVAT><typ:ids>${esc(inv.account_credit)}</typ:ids></inv:classificationVAT>` : ''}
      </inv:invoiceHeader>
      <inv:invoiceDetail>${itemsXml}
      </inv:invoiceDetail>
      <inv:invoiceSummary>
        <inv:roundingDocument>math2one</inv:roundingDocument>
        <inv:homeCurrency>
          <typ:priceNone>0.00</typ:priceNone>
          <typ:priceLow>0.00</typ:priceLow>
          <typ:priceLowVAT>0.00</typ:priceLowVAT>
          <typ:priceLowSum>0.00</typ:priceLowSum>
          <typ:priceHigh>${fmtNum(inv.amount)}</typ:priceHigh>
          <typ:priceHighVAT>${fmtNum(inv.vat_amount)}</typ:priceHighVAT>
          <typ:priceHighSum>${fmtNum(inv.total_amount)}</typ:priceHighSum>
          <typ:round><typ:priceRound>0.00</typ:priceRound></typ:round>
        </inv:homeCurrency>
        <inv:foreignCurrency>
          <typ:currency>
            <typ:ids>${esc(inv.currency || 'CZK')}</typ:ids>
          </typ:currency>
        </inv:foreignCurrency>
      </inv:invoiceSummary>
    </inv:invoice>
  </dat:dataPackItem>`;
}

// Účtenka → POHODA XML element (jako přijatý doklad / voucher)
function receiptToXml(r, idx = 1) {
  return `  <dat:dataPackItem id="${idx}" version="2.0">
    <vou:voucher version="2.0">
      <vou:voucherHeader>
        <vou:voucherType>expense</vou:voucherType>
        <vou:number>
          <typ:numberRequested>${esc(r.number || '')}</typ:numberRequested>
        </vou:number>
        <vou:date>${fmtDate(r.receipt_date)}</vou:date>
        <vou:text>${esc(r.vendor || '')}${r.notes ? ' — ' + r.notes : ''}</vou:text>
        <vou:partnerIdentity>
          <typ:address>
            <typ:company>${esc(r.vendor || '')}</typ:company>
            ${r.vendor_ico ? `<typ:ico>${esc(r.vendor_ico)}</typ:ico>` : ''}
          </typ:address>
        </vou:partnerIdentity>
        <vou:account>
          <typ:ids>518</typ:ids>
        </vou:account>
      </vou:voucherHeader>
      <vou:voucherSummary>
        <vou:homeCurrency>
          <typ:priceNone>0.00</typ:priceNone>
          <typ:priceLow>0.00</typ:priceLow>
          <typ:priceLowVAT>0.00</typ:priceLowVAT>
          <typ:priceLowSum>0.00</typ:priceLowSum>
          <typ:priceHigh>${fmtNum(r.amount)}</typ:priceHigh>
          <typ:priceHighVAT>${fmtNum(r.vat_amount)}</typ:priceHighVAT>
          <typ:priceHighSum>${fmtNum(r.total_amount)}</typ:priceHighSum>
          <typ:round><typ:priceRound>0.00</typ:priceRound></typ:round>
        </vou:homeCurrency>
      </vou:voucherSummary>
    </vou:voucher>
  </dat:dataPackItem>`;
}

export function buildPohodaXml(items) {
  const header = `<?xml version="1.0" encoding="UTF-8"?>
<dat:dataPack
  xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
  xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd"
  xmlns:vou="http://www.stormware.cz/schema/version_2/voucher.xsd"
  xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd"
  id="pohoda-export" application="one.seil.space" version="2.0"
  note="Export z one.seil.space">`;

  const body = items.map((item, i) => {
    if (item._type === 'receipt') return receiptToXml(item, i + 1);
    return invoiceToXml(item, item._items || [], i + 1);
  }).join('\n');

  return header + '\n' + body + '\n</dat:dataPack>';
}
