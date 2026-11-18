-- Sledování zásilek odeslaných do skladu.
--
-- Plánovač (src/sledovani-zasilek.js) se ptá Zásilkovny na stav zásilky
-- každé objednávky, která odešla do skladu a ještě není vyřízená. Jakmile
-- Zásilkovna balík převezme, objednávka se vyřídí sama: vznikne faktura,
-- zákazník dostane tentýž e-mail jako po ručním přepnutí na „Vyřízena“.
--
-- Poslední zjištěný stav se ukládá k objednávce, ať je na detailu vidět, co
-- Zásilkovna hlásí, i když automat zatím nic neudělal.

-- `codeText` z API Zásilkovny („received data“, „arrived“…): podle něj se
-- rozhoduje. Je to stálý anglický identifikátor, číselný kód ani lokalizovaný
-- text se k rozhodování nepoužívají.
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS packet_status       TEXT NOT NULL DEFAULT '';
-- `statusText` z téhož volání, jen pro zobrazení.
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS packet_status_text  TEXT NOT NULL DEFAULT '';
-- Kdy stav u Zásilkovny nastal (`dateTime`), ne kdy jsme se ptali.
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS packet_status_at    TIMESTAMPTZ;
-- Kdy jsme se naposledy ptali – plánovač podle toho ředí dotazy.
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS packet_checked_at   TIMESTAMPTZ;

-- Objednávku vyřídil automat po převzetí zásilky (ne obsluha).
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS auto_fulfilled_at   TIMESTAMPTZ;
-- Co se automatu nepovedlo (faktura nevznikla, e-mail neodešel). Prázdné =
-- v pořádku. Ruční vyřízení ho maže.
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS auto_fulfill_error  TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN shop_orders.packet_status IS
  'Poslední stav zásilky u Zásilkovny (codeText z packetStatus). Prázdné = ještě jsme se neptali.';
COMMENT ON COLUMN shop_orders.auto_fulfilled_at IS
  'Kdy objednávku vyřídilo sledování zásilek, protože Zásilkovna převzala balík. NULL = vyřídila ji obsluha, nebo ještě není vyřízená.';
