-- ============================================================
-- one.seil.space — skrytá kopie ranní expedice
-- ============================================================
-- Expedice odcházela jen na adresu skladu a nikdo z firmy neviděl, co sklad
-- ráno dostal — kontrolovat to šlo jen zpětně podle `resend_id` v běhu.
-- Adresa kopie patří k e-shopu, ne do prostředí: `EMAIL_BCC` je kopie
-- zákaznické pošty a míchat tyhle dva toky by znamenalo, že se kopie skladu
-- nedá zapnout bez kopie všeho ostatního.
--
-- Skrytá schválně: sklad odpovídá na expedici a adresa v „Komu“ navíc by
-- svedla odpovědět i tomu, kdo zásilky nevyřizuje.

ALTER TABLE shops ADD COLUMN IF NOT EXISTS warehouse_email_bcc TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN shops.warehouse_email_bcc IS
  'Adresa, která dostane skrytou kopii ranní expedice. Prázdné = kopie se neposílá. Nezávislé na EMAIL_BCC, což je kopie zákaznické pošty.';
