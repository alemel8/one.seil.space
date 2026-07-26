# TODO — zprovoznění importu faktur z Google Disku

Kód je nasazený (commit `ce481f5`), ale integrace nezačne fungovat, dokud se
nedodá přístup ke Google Disku. Než je hotovo, stránka
`/ucetnictvi/prijate-faktury/gdrive` hlásí, co konkrétně chybí.

---

## 1. Service account v Google Cloud

- [ ] [console.cloud.google.com](https://console.cloud.google.com) → vybrat nebo založit projekt
- [ ] **Enable APIs & Services** → zapnout **Google Drive API**
- [ ] **IAM & Admin → Service Accounts** → *Create service account* (název např. `one-seil`)
- [ ] U vytvořeného účtu **Keys → Add key → Create new key → JSON** → stáhnout soubor
- [ ] Poznamenat si `client_email` z JSONu (tvar `one-seil@…iam.gserviceaccount.com`)

## 2. Proměnná prostředí v Coolify

- [ ] Přidat env var `GOOGLE_SERVICE_ACCOUNT_JSON` = **celý obsah** staženého JSON souboru
      (v jedné proměnné; escapované `\n` v privátním klíči si aplikace přeloží sama)
- [ ] Redeploy aplikace

## 3. Nasdílení složky na Disku

- [ ] Na Google Disku u složky **SEIL - účetnictví** → *Sdílet*
- [ ] Vložit `client_email` service accountu, právo **Čtenář**

> Stačí nasdílet kořenovou složku — podsložky rok / měsíc / Přijaté faktury
> dědí přístup automaticky.

## 4. Nastavení v aplikaci

- [ ] **Nastavení → Firma → Google Disk** → vyplnit **ID složky**
      (z URL složky: `drive.google.com/drive/folders/`**`ID`**)
- [ ] Uložit

## 5. Ověření

- [ ] **Účetnictví → Přijaté faktury → ☁ Načíst z Google Disku**
- [ ] Vybrat rok a měsíc → měl by se vypsat seznam dokladů ze složky
- [ ] Naimportovat **jednu** fakturu a zkontrolovat vytěžená data (dodavatel,
      IČO, částky, datumy) a přiložené PDF
- [ ] Teprve pak spustit hromadný import

---

## Jak to funguje

Prochází se struktura `<sdílená složka> / <rok> / <měsíc> / Přijaté faktury`.
Názvy měsíců se poznávají tolerantně — `7. Červenec`, `07 - červenec`
i `Červenec` fungují, u podsložky stačí, že název obsahuje „přijaté“
(bez ohledu na diakritiku a velikost písmen).

Každý soubor se páruje přes Drive file ID (`accounting_invoices.gdrive_file_id`,
unikátní index), takže opakovaný import nic nezduplikuje — ani po přejmenování
nebo přesunu souboru na Disku.

Import běží na pozadí s ukazatelem průběhu; vytěžení jedné faktury přes Claude
trvá zhruba 10 sekund.

Přístup je **jen pro čtení** (scope `drive.readonly`) — aplikace na Disku nic
nemění ani nemaže.

---

## Neověřeno

Reálné volání Drive API a vytěžení skutečné faktury nebylo možné otestovat bez
přihlašovacích údajů. Otestované je: procházení složek a JWT přihlášení proti
nasimulovanému Drive API, migrace proti čisté databázi, registrace rout
a vykreslení stránek.

## Možné rozšíření

- [ ] **Automatická synchronizace** — kontrola nových souborů každou hodinu na
      pozadí, bez klikání. Aplikace už takový mechanismus má pro healthchecky
      (`src/server.js`, `setInterval`), jde o malý dodělek.
- [ ] **Notifikace** při nalezení nové faktury (push kanál v systému už je)
- [ ] **Předkontace** u importovaných faktur — teď se zakládají prázdné

---

## Hotovo

- [x] Export účtenek do POHODY (agenda Pokladna) — opraveno a ověřeno v provozu
- [x] Rychlý odkaz na Účtenky na homepage
- [x] Import z Google Disku — kód, stránka, dedup, běh na pozadí
