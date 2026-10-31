# TODO – zprovoznění importu faktur z Google Disku

Faktura uložená do složky na Disku se sama vytěží a založí v One SEIL. Než je
přístup hotový, stránka `/ucetnictvi/prijate-faktury/gdrive` hlásí, co konkrétně
chybí, a ukazuje čas i chybu poslední automatické kontroly.

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

> Stačí nasdílet kořenovou složku – podsložky rok / měsíc / Přijaté faktury
> dědí přístup automaticky.

## 4. Nastavení v aplikaci

- [ ] **Nastavení → Firma → tužka vpravo nahoře → Google Disk** → vyplnit **ID složky**
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
Názvy měsíců se poznávají tolerantně – `7. Červenec`, `07 - červenec`
i `Červenec` fungují, u podsložky stačí, že název obsahuje „přijaté“
(bez ohledu na diakritiku a velikost písmen).

Každý soubor se páruje přes Drive file ID (`accounting_invoices.gdrive_file_id`,
unikátní index), takže opakovaný import nic nezduplikuje – ani po přejmenování
nebo přesunu souboru na Disku. Stejné číslo od jiného dodavatele je nová faktura.

**Automatika** (`src/gdrive-import.js`) kontroluje každých 5 minut letošní
a loňský rok. První úspěšná kontrola jen zapíše, co ve složce je (stav `vychozi`
v `gdrive_soubory`), a nic neimportuje: ty doklady jsou v systému z POHODY a na
stránce nejsou předvybrané. Importuje se až to, co přibude později. Po změně ID
složky se výchozí stav zapíše znovu.

Před založením se hledá stejná faktura bez vazby na Disk: stejné IČO a číslo dokladu
a k tomu datum nebo částka, nebo stejné IČO, datum a částka; když jedna strana IČO nemá,
stejné číslo a název a k tomu datum nebo částka. Shoda s jedinou fakturou se k ní
připojí (doplní se vazba a chybějící příloha, číslo a stav zůstávají). Číslo samo
nestačí, u faktur z POHODY je v `number` její interní číslo.

Když se nepřipojí a v systému je faktura se stejným číslem i dodavatelem, se stejným
číslem (bez ohledu na mezery a pomlčky), datem a částkou, nebo u dokladu bez čísla se
stejným dodavatelem, datem a částkou, soubor skončí stavem `chyba`, nic se nezaloží
a rozhodne člověk. Datum v jiném tvaru než RRRR-MM-DD je taky chyba, jinak by se uložilo
posunuté. Doklad bez vytěženého čísla dostane jako číslo název souboru.

Známé meze, které se neřeší, protože v řádku není uložený jeho původ:

- Dva doklady téhož dodavatele se stejným dnem a částkou a jiným číslem (dvě obnovy
  domén): když je jeden zadaný ručně nebo z POHODY, druhý se k němu připojí a číslo
  se nezapíše. Stejná shoda je jediná cesta k faktuře z POHODY s interním číslem.
- Když takové řádky bez vazby na Disk existují dva a doklad má jiné číslo, připojení
  je nejasné, takže vznikne třetí řádek.
- Dva různí dodavatelé se stejným číslem, datem a částkou skončí chybou, faktura se
  založí ručně.
- Kopie téhož dokladu vytěžená nejdřív bez čísla (číslem je název souboru) a pak s číslem
  založí dva řádky. Opačné pořadí skončí chybou.

Nevytěžený doklad fakturu nezaloží. Zkusí se znovu po hodině, nejvýš 5×, pak
přijde push a zbývá ruční import ze stránky. Za jednu kontrolu se zpracuje nejvýš
25 dokladů. O nově načtených dokladech chodí push.

Ruční výběr na stránce běží na pozadí s ukazatelem průběhu; vytěžení jedné
faktury přes Claude trvá zhruba 10 sekund.

Přístup je **jen pro čtení** (scope `drive.readonly`) – aplikace na Disku nic
nemění ani nemaže.

---

## Neověřeno

Reálné volání Drive API a vytěžení skutečné faktury nebylo možné otestovat bez
přihlašovacích údajů. Otestované je (`test/gdrive-import.test.js`): procházení
složek proti nasimulovanému Drive API, výchozí stav, slučování, pokusy, migrace
proti čisté databázi a vykreslení stránky.

## Možné rozšíření

- [ ] **Předkontace** u importovaných faktur – teď se zakládají prázdné

---

## Hotovo

- [x] Export účtenek do POHODY (agenda Pokladna) – opraveno a ověřeno v provozu
- [x] Rychlý odkaz na Účtenky na homepage
- [x] Import z Google Disku – kód, stránka, dedup, běh na pozadí
- [x] Automatický import nových dokladů a push o výsledku
