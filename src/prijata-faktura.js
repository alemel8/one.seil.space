// Kontroly čísla přijaté faktury, které unikátní index (migrace 045) neumí.
// Jsou to dotazy před zápisem, ne atomické; v souběhu můžou propustit dvojici.

/**
 * Stejné číslo a název dodavatele, jedna kopie bez IČO. Index to vyjádřit nemůže:
 * řádek bez IČO by musel kolidovat s každým IČO, ta spolu ale kolidovat nesmějí.
 * Obě IČO vyplněná a různá jsou různí dodavatelé, stejná IČO řeší index.
 */
export async function shodaBezIco(sql, { number, supplier, ico, krome = '' }) {
  if (!number || !supplier) return null;
  const [shoda] = await sql`
    SELECT id FROM accounting_invoices
    WHERE type = 'received' AND number = ${number} AND id <> ${krome}
      AND lower(btrim(supplier)) = lower(btrim(${supplier}))
      AND (ico_klic(supplier_ico) IS NULL OR ico_klic(${ico}) IS NULL)
    LIMIT 1
  `;
  return shoda ?? null;
}

/**
 * Stejné číslo, datum i částka: tentýž doklad, i když se dodavatel vytěžil nebo
 * zapsal jinak. Dva různí dodavatelé se na všech třech prakticky neshodnou. Číslo
 * se porovnává bez mezer, pomlček a velikosti písmen: FA-77 a fa 77 je totéž.
 */
export async function shodaCislaDataCastky(sql, { number, datum, celkem }) {
  if (!number || !datum) return null;
  const [shoda] = await sql`
    SELECT id FROM accounting_invoices
    WHERE type = 'received'
      AND regexp_replace(upper(number), '[^0-9A-Z]', '', 'g') <> ''
      AND regexp_replace(upper(number), '[^0-9A-Z]', '', 'g') = regexp_replace(upper(${number}), '[^0-9A-Z]', '', 'g')
      AND issue_date = ${datum}::date AND total_amount = ${celkem}::numeric
    LIMIT 1
  `;
  return shoda ?? null;
}

/**
 * Doklad bez vytěženého čísla: stejný dodavatel, datum a částka, jiný znak nezbývá.
 * Dodavatel jako v klíči faktury: stejné IČO, nebo název, když jedna strana IČO nemá.
 */
export async function shodaBezCisla(sql, { supplier, ico, datum, celkem }) {
  if (!datum) return null;
  const [shoda] = await sql`
    SELECT id FROM accounting_invoices
    WHERE type = 'received'
      AND issue_date = ${datum}::date AND total_amount = ${celkem}::numeric
      AND (
        ico_klic(supplier_ico) = ico_klic(${ico})
        OR (lower(btrim(supplier)) = lower(btrim(${supplier})) AND (ico_klic(supplier_ico) IS NULL OR ico_klic(${ico}) IS NULL))
      )
    LIMIT 1
  `;
  return shoda ?? null;
}
