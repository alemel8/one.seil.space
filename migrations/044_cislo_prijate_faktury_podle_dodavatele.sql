-- Číslo přijaté faktury přiděluje dodavatel, takže dva různí dodavatelé můžou
-- mít stejné číslo a v praxi se to stává. Jedinečné je jen v rámci dodavatele.
-- Vydané a zálohové faktury drží dál (typ, číslo): číslo jim dává vlastní řada.
--
-- Stejný dodavatel: IČO, když je vyplněné, jinak název bez ohledu na velikost
-- písmen a okrajové mezery. Z IČO se berou jen písmena a číslice bez úvodních
-- nul (123 45 678 = 12345678, Excel nuly ukusuje); NULL, prázdné i samé nuly
-- znamenají bez IČO. Různá IČO jsou vždy různí dodavatelé, i se stejným názvem.
--
-- Řádek s IČO se v indexu nepotká s řádkem bez IČO. Tu shodu (stejné číslo
-- a název, jedna kopie bez IČO) hlídá aplikace: unikátní index ji vyjádřit
-- neumí, řádek bez IČO by musel kolidovat s každým IČO, ta spolu ale kolidovat
-- nesmějí.
--
-- Nad existujícími daty projde vždy: starý index drží jedinečné (typ, číslo)
-- a nový klíč číslo obsahuje, kolize v novém by byla kolizí už ve starém.
--
-- Běží v jedné transakci (src/migrate.js), takže CONCURRENTLY nejde. DROP INDEX
-- bere na accounting_invoices výhradní zámek a drží ho do COMMIT; stavba obou
-- indexů trvá kolem 20 ms nad 5 000 řádků a 0,2 s nad 50 000 řádků. Nejdřív DROP,
-- pak CREATE: zámek se bere jednou, bez povyšování ze SHARE, které končí
-- deadlockem s transakcí, která čte a pak zapisuje. lock_timeout 2 s: když DROP
-- čeká za cizí transakcí (pg_dump, zapomenutá psql session), radši ať start
-- spadne, celá transakce se vrátí a kontejner to zkusí znovu
-- (docs/druhy-eshop.md, servisní okno).

SET LOCAL lock_timeout = '2s';

DROP INDEX IF EXISTS accounting_invoices_type_number_idx;

CREATE UNIQUE INDEX IF NOT EXISTS accounting_invoices_type_number_idx
  ON accounting_invoices (type, number)
  WHERE number <> '' AND type <> 'received';

CREATE UNIQUE INDEX IF NOT EXISTS accounting_invoices_received_number_supplier_idx
  ON accounting_invoices (
    number,
    (COALESCE(
      NULLIF(ltrim(regexp_replace(supplier_ico, '[^0-9A-Za-z]', '', 'g'), '0'), ''),
      lower(btrim(supplier))
    ))
  )
  WHERE type = 'received' AND number <> '';
