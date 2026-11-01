// Barevný tón stavu pro odznak (.badge-ok, -varovani, -chyba, -info, -neutral
// v public/css/components.css). Jedna mapa místo kopií barev v šablonách.

const TONY = new Map(Object.entries({
  // Faktury
  Zaplacena: 'ok', Nezaplacena: 'varovani', 'Po splatnosti': 'chyba', Storno: 'neutral',
  // Účtenky
  'Zaúčtována': 'ok', 'Nezaúčtována': 'varovani',
  // Objednávky
  'Přijata': 'info', 'Vyřízena': 'ok', 'Stornována': 'chyba',
  // Úkoly
  done: 'ok', in_progress: 'info', on_hold: 'neutral', todo: 'varovani',
  // Projekty a smlouvy
  'Aktivní': 'ok', 'Pozastaveno': 'varovani', 'Dokončeno': 'ok', 'Archivováno': 'neutral', 'Ukončená': 'neutral',
  // Upomínky
  ceka: 'varovani', odeslana: 'ok', zrusena: 'neutral',
}));

export function tonStavu(stav) {
  return TONY.get(stav) ?? 'neutral';
}
