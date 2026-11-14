/**
 * Předkontace a členění DPH podle předchozích dokladů téhož partnera.
 *
 * Účetní v POHODĚ zaúčtuje každého dodavatele po svém: Anthropic, GitHub nebo
 * Resend jako 11Fp s členěním „bez“, WEDOS jako 13Fp a PD. Faktura, která
 * do One SEIL přišla z Disku, tyhle zkratky nezná. Export do POHODY je proto
 * vezme z posledního dokladu téhož partnera, který je má (doplnil je import
 * exportu z POHODY, migrace 050). Bez vzoru POHODA nastaví svoji výchozí
 * předkontaci a doklad zaúčtuje jako tuzemský.
 *
 * Partnera pozná podle IČO. Zahraniční dodavatel IČO nemá a jeho název se
 * v POHODĚ liší podle toho, kdo doklad zadal („Anthropic, PBC“ i „Anthropic,
 * PBC @anthropic548 Market Street…“), takže stačí, když jeden název začíná
 * druhým. Faktury ze Stripe mají číslo „PŘEDPONA-pořadí“ s předponou za
 * dodavatele a odběratele (IM69EW9T-0034, 9BF0758D-12647992), ta spojí
 * i doklady, u kterých se název změnil (Anthropic, PBC → Anthropic Ireland).
 */

const str = (v) => String(v ?? '').trim();

/** IČO jako klíč, stejně jako ico_klic v databázi (migrace 045). */
const icoKlic = (v) => str(v).replace(/[^0-9A-Za-z]/g, '').toUpperCase().replace(/^CZ/, '').replace(/^0+/, '');

/** Název bez diakritiky, mezer a interpunkce: „Anthropic, PBC“ → „anthropicpbc“. */
const klicNazvu = (v) => str(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Kratší název než tohle („alza“) jako předpona jiného nestačí, musí se shodovat celý.
const MIN_PREDPONA_NAZVU = 8;

/** Předpona čísla faktury ze Stripe: osm znaků, pomlčka, pořadí. */
function predponaStripe(cislo) {
  const m = str(cislo).toUpperCase().match(/^([0-9A-Z]{8})-\d+$/);
  return m ? m[1] : null;
}

function partner(doc) {
  const vydana = doc.type !== 'received';
  return {
    ico: icoKlic(vydana ? doc.client_ico : doc.supplier_ico),
    nazev: klicNazvu(vydana ? doc.client_name : doc.supplier),
    predpony: vydana ? [] : [predponaStripe(doc.number), predponaStripe(doc.supplier_number)].filter(Boolean),
  };
}

/** Jsou dva doklady od téhož partnera? Obě IČO rozhodují sama. */
export function stejnyPartner(a, b) {
  const pa = partner(a);
  const pb = partner(b);
  if (pa.ico && pb.ico) return pa.ico === pb.ico;
  if (pa.nazev && pa.nazev === pb.nazev) return true;
  const [kratsi, delsi] = pa.nazev.length <= pb.nazev.length ? [pa.nazev, pb.nazev] : [pb.nazev, pa.nazev];
  if (kratsi.length >= MIN_PREDPONA_NAZVU && delsi.startsWith(kratsi)) return true;
  return pa.predpony.some(p => pb.predpony.includes(p));
}

const sDph = (doc) => Number(doc.vat_amount || 0) !== 0;

/**
 * Vzor pro doklad bez vlastní předkontace: zkratky z nejnovějšího dokladu
 * téhož partnera. historie = doklady se zkratkou, od nejnovějšího.
 *
 * Členění se převezme, jen když oba doklady stejně mají, nebo nemají DPH.
 * „bez“ od dodavatele, který dřív DPH neúčtoval, by jinak vyřadil z přiznání
 * doklad, na kterém DPH je.
 *
 *   → { predkontace, cleneni, cislo } nebo null
 */
export function najdiVzor(doc, historie) {
  for (const h of historie) {
    if (h.id === doc.id || h.type !== doc.type || !str(h.pohoda_predkontace)) continue;
    if (!stejnyPartner(doc, h)) continue;
    return {
      predkontace: str(h.pohoda_predkontace),
      cleneni: sDph(h) === sDph(doc) ? str(h.pohoda_cleneni_dph) : '',
      cislo: h.internal_number || h.number,
    };
  }
  return null;
}

/** Doklady daného typu, které zkratky z POHODY mají, od nejnovějšího. */
export function historiePredkontaci(sql, type) {
  return sql`
    SELECT id, type, number, internal_number, supplier_number, supplier, supplier_ico,
           client_name, client_ico, vat_amount, pohoda_predkontace, pohoda_cleneni_dph
    FROM accounting_invoices
    WHERE type = ${type} AND pohoda_predkontace <> ''
    ORDER BY issue_date DESC NULLS LAST, created_at DESC
  `;
}
