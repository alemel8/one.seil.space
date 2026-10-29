-- ============================================================
-- one.seil.space — Dílna Vlněnka: číslo faktury a vzhled e-mailů
-- ============================================================
-- Obojí si vyžádal majitel 29. 10. 2026. Mění se jen řádky Dílny (slug
-- 'dilnavlnenka'); Toneráčku se nedotkne žádný příkaz — každý UPDATE je
-- vázaný na slug Dílny a zamyká jen její řádky, ne celou tabulku.
--
-- Faktury Dílny ve tvaru YYMMNNN (např. 2610001). Řadu jde v administraci
-- jen založit a (de)aktivovat, ne upravit; nová řada a deaktivace staré by
-- v seznamu nechala mrtvý řádek, což majitel nechce. Proto UPDATE na místě.
-- Pořadí se nenuluje — YYMM je předpona, NNN běží dál přes měsíce
-- (2610001, 2611002, …), stejně jako YYYYNNNN u Toneráčku přes roky.
-- Srazit se s Toneráčkem nemůže: jeho čísla začínají rokem (2026…), Dílny
-- dvojčíslím roku a měsícem (2601–2612…). Hlídá to i UNIQUE (type, number)
-- z migrace 021.
--
-- Vzhled e-mailů podle webu (src/app/globals.css e-shopu): terakota
-- accent-600 jako hlavní barva, 700 a 500 do přechodu v hlavičce, 100 pro
-- podtitulek na přechodu. Znak v hlavičce má vlastní krémový kruh, takže je
-- na terakotě vidět; logo s nápisem jde do bílé patičky. Oba obrázky jsou
-- v public/images/brand/ e-shopu.
--
-- Adresa ahoj@ nebude (rozhodnutí 29. 10. 2026): kde v identitě zůstala,
-- nahradí ji info@ (odpovědi, kontakt), u odesílatele noreply@. Jiné
-- hodnoty, které majitel vyplnil, se nepřepisují.

SET LOCAL lock_timeout = '2s';

UPDATE invoice_number_series s
SET format = 'YYMMNNN'
FROM shops sh
WHERE sh.id = s.shop_id
  AND sh.slug = 'dilnavlnenka'
  AND s.entity_type = 'faktura'
  AND s.active
  AND s.format IS DISTINCT FROM 'YYMMNNN';

UPDATE shops SET
  logo_mark_url         = 'https://dilnavlnenka.cz/images/brand/znak-email.png',
  logo_wordmark_url     = 'https://dilnavlnenka.cz/images/brand/logo-email.png',
  color_primary         = '#A85E56',
  color_primary_dark    = '#8E4C45',
  color_primary_light   = '#C4756B',
  color_on_primary_soft = '#FCF3F1'
WHERE slug = 'dilnavlnenka';

UPDATE shops SET email_reply_to = 'info@dilnavlnenka.cz'
WHERE slug = 'dilnavlnenka' AND lower(trim(email_reply_to)) = 'ahoj@dilnavlnenka.cz';

UPDATE shops SET support_email = 'info@dilnavlnenka.cz'
WHERE slug = 'dilnavlnenka' AND lower(trim(support_email)) = 'ahoj@dilnavlnenka.cz';

UPDATE shops SET email_from_address = 'noreply@dilnavlnenka.cz'
WHERE slug = 'dilnavlnenka' AND lower(trim(email_from_address)) = 'ahoj@dilnavlnenka.cz';
