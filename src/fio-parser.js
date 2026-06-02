// Parser Fio CSV výpisu
// Formát: středníkový separátor, 6 hlavičkových řádků, pak záhlaví sloupců, pak data

export function parseFioCsv(csvText) {
  const lines = csvText.split('\n').map(l => l.trimEnd());

  // Najdi řádek s záhlavím sloupců (obsahuje "ID operace")
  const headerIdx = lines.findIndex(l => l.startsWith('ID operace;'));
  if (headerIdx === -1) throw new Error('Neplatný formát Fio CSV — nenalezeno záhlaví sloupců');

  // Parsuj metadata z prvních řádků
  const meta = {};
  for (let i = 0; i < headerIdx; i++) {
    const line = lines[i];
    if (line.includes('Výpis č.'))       meta.reportNumber = line.match(/Výpis č\. (.+?) z účtu/)?.[1] || '';
    if (line.includes('z účtu'))         meta.accountNumber = line.match(/"(\d+\/\d+)"/)?.[1] || '';
    if (line.includes('Majitel účtu'))   meta.accountName = line.match(/Majitel účtu: (.+?), /)?.[1] || '';
    if (line.includes('Období'))         {
      const m = line.match(/(\d{2}\.\d{2}\.\d{4}) - (\d{2}\.\d{2}\.\d{4})/);
      if (m) { meta.dateFrom = parseCzDate(m[1]); meta.dateTo = parseCzDate(m[2]); }
    }
  }

  // Záhlaví sloupců
  const columns = lines[headerIdx].split(';');

  // Mapování sloupců
  const colIdx = {
    id:                columns.indexOf('ID operace'),
    date:              columns.indexOf('Datum'),
    amount:            columns.indexOf('Objem'),
    currency:          columns.indexOf('Měna'),
    counterpartyAcct:  columns.indexOf('Protiúčet'),
    counterpartyName:  columns.indexOf('Název protiúčtu'),
    bankCode:          columns.indexOf('Kód banky'),
    bankName:          columns.indexOf('Název banky'),
    constantSymbol:    columns.indexOf('KS'),
    variableSymbol:    columns.indexOf('VS'),
    specificSymbol:    columns.indexOf('SS'),
    message:           columns.indexOf('Zpráva pro příjemce'),
    type:              columns.indexOf('Typ'),
    note:              columns.indexOf('Poznámka'),
  };

  const records = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cells = line.split(';');
    if (!cells[colIdx.id]) continue;

    const amount = parseFloat((cells[colIdx.amount] || '0').replace(',', '.'));
    if (isNaN(amount)) continue;

    records.push({
      external_id:          cells[colIdx.id]?.trim() || '',
      transaction_date:     parseCzDate(cells[colIdx.date] || ''),
      amount:               Math.abs(amount),
      type:                 amount >= 0 ? 'credit' : 'debit',
      currency:             cells[colIdx.currency]?.trim() || 'CZK',
      counterparty_account: cells[colIdx.counterpartyAcct]?.trim() || '',
      counterparty_name:    cells[colIdx.counterpartyName]?.trim() || '',
      constant_symbol:      cells[colIdx.constantSymbol]?.trim() || '',
      variable_symbol:      cells[colIdx.variableSymbol]?.trim() || '',
      specific_symbol:      cells[colIdx.specificSymbol]?.trim() || '',
      message:              cells[colIdx.message]?.trim() || cells[colIdx.note]?.trim() || '',
    });
  }

  return { meta, records };
}

function parseCzDate(str) {
  // DD.MM.YYYY → YYYY-MM-DD
  const m = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return str;
  return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
}
