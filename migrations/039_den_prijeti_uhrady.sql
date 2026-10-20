-- ============================================================
-- one.seil.space — den přijetí úhrady a datum zdanitelného plnění
-- ============================================================
-- Faktura k objednávce e-shopu vzniká až přepnutím na „Vyřízena“, často dny
-- po platbě, a okamžik platby se do té doby nikam neukládal. Karta zaplacená
-- 1. 9. proto dostala na fakturu „zaplaceno 7. 9.“ a PDF neneslo žádné datum
-- plnění. Daňový doklad přitom musí uvádět den uskutečnění plnění nebo den
-- přijetí úplaty, liší-li se ode dne vystavení (§ 29 odst. 1 písm. h ZDPH),
-- a vystavit se má do 15 dnů ode dne, kdy vznikla povinnost přiznat daň
-- (§ 28 odst. 8). Bez obou sloupců nejde ani jedno.
--
-- **`shop_orders.paid_at`** — okamžik, kdy e-shop poprvé ohlásil zaplacení
-- (v praxi kartou): stavem „Zaplaceno“ v PATCH payment-status nebo
-- payment-method, nebo už při založení objednávky (POST se stavem
-- „Zaplaceno“). Okamžik, ne datum: pražský den se z něj počítá až při
-- vystavení faktury a v hlídání lhůty, protože platba ve 0:30 pražského času
-- je v UTC ještě předchozí den. U převodu rozhoduje den úhrady zálohové
-- faktury (`paid_date`), u dobírky odeslání do skladu — tam se `paid_at`
-- nepoužívá.
--
-- **`accounting_invoices.taxable_date`** — DUZP vydané faktury. U karty
-- a převodu den přijetí úplaty, u dobírky den vystavení (plnění = odeslání).
-- Obsluha ho může opravit v úpravě faktury.
--
-- Nic se zpětně nedoplňuje — ani `paid_at`, ani `taxable_date` už vydaných
-- faktur. Vymyšlené datum na už vydaném daňovém dokladu je horší než žádné;
-- NULL v `taxable_date` znamená „stejné jako datum vystavení“, tak se to
-- tisklo i exportovalo dosud. Zaplacené karty bez `paid_at`, ke kterým se
-- faktura vystaví až po migraci, dostanou za den přijetí úplaty pražský den
-- založení objednávky (karta se platí rovnou v pokladně) — počítá se při
-- vystavení, do databáze se nepíše. Viz denPlatbyKartou() v
-- src/danovy-doklad.js.

ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

COMMENT ON COLUMN shop_orders.paid_at IS
  'Kdy e-shop poprvé ohlásil zaplacení (stav „Zaplaceno“ při založení objednávky nebo v PATCH payment-status / payment-method). Další potvrzení ho nepřepíší. NULL = neohlášeno (převod, dobírka, objednávky před migrací 039); u zaplacené karty bez něj bere faktura den založení objednávky.';

ALTER TABLE accounting_invoices ADD COLUMN IF NOT EXISTS taxable_date DATE;

COMMENT ON COLUMN accounting_invoices.taxable_date IS
  'Datum uskutečnění zdanitelného plnění (DUZP) vydané faktury. U objednávky placené kartou nebo převodem den přijetí úplaty, u dobírky den vystavení. NULL = shodné s issue_date (starší a ruční doklady).';
