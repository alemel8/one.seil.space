// Serverové záložky (?tab=): seznam [klíč, popisek, …] drží routa, pruh vykresluje
// views/includes/zalozky.ejs. Popis v docs/moduly.md (Záložky na stránkách).

/** Klíč otevřené záložky. Neznámá hodnota i pole z ?tab=a&tab=b padá na první záložku. */
export function zalozka(seznam, hodnota) {
  return seznam.some(([klic]) => klic === hodnota) ? hodnota : seznam[0][0];
}
