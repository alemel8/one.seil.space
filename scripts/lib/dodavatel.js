/**
 * Je řádek přijaté faktury od stejného dodavatele jako doklad z importu?
 * Stejná pravidla jako index z migrace 044: IČO bez mezer a úvodních nul,
 * a když chybí, název bez ohledu na velikost písmen.
 *
 *   'stejny'   obě IČO shodná, nebo jedno chybí a názvy se shodují
 *   'jiny'     obě IČO různá, nebo žádné IČO a různé názvy
 *   'nejisty'  jedna strana IČO nemá a názvy se liší: nic se nepřepíše ani
 *              nezaloží, rozhodne člověk
 */
const str = (v) => String(v ?? '').trim();
const icoKlic = (v) => str(v).replace(/[^0-9A-Za-z]/g, '').replace(/^0+/, '');

export function porovnejDodavatele(radek, doklad) {
  const a = icoKlic(radek.supplier_ico);
  const b = icoKlic(doklad.ico);
  if (a && b) return a === b ? 'stejny' : 'jiny';
  if (str(radek.supplier).toLowerCase() === str(doklad.name).toLowerCase()) return 'stejny';
  return a || b ? 'nejisty' : 'jiny';
}
