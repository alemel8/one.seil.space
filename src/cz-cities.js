// Souřadnice českých měst (okresní města + Praha) pro vykreslení na mapě
// na homepage dashboardu. Mapový podklad: /public/img/cz-mapa.svg
// (Wikimedia Commons, "Czech Republic location map blank.svg",
// projekce: top 51.3°, bottom 48.3°, left 11.8°, right 19.2°).
//
// Pokrývá hlavní/okresní města — menší obce, které nejsou v tomto
// seznamu, se na mapu nevykreslí, ale zobrazí se v seznamu "Ostatní".

export const MAP_BOUNDS = { top: 51.3, bottom: 48.3, left: 11.8, right: 19.2 };

export const CITY_COORDS = {
  praha:                  [50.0875, 14.4213, 'Praha'],
  benesov:                [49.7838, 14.6868, 'Benešov'],
  beroun:                 [49.9647, 14.0729, 'Beroun'],
  kladno:                 [50.1429, 14.1042, 'Kladno'],
  kolin:                  [50.0282, 15.2003, 'Kolín'],
  'kutna hora':           [49.9479, 15.2683, 'Kutná Hora'],
  melnik:                 [50.3511, 14.4730, 'Mělník'],
  'mlada boleslav':       [50.4314, 14.9070, 'Mladá Boleslav'],
  nymburk:                [50.1879, 15.0414, 'Nymburk'],
  pribram:                [49.6886, 14.0103, 'Příbram'],
  rakovnik:               [50.1056, 13.7297, 'Rakovník'],
  'ceske budejovice':     [48.9747, 14.4744, 'České Budějovice'],
  'cesky krumlov':        [48.8127, 14.3175, 'Český Krumlov'],
  'jindrichuv hradec':    [49.1455, 15.0027, 'Jindřichův Hradec'],
  pelhrimov:              [49.4286, 15.2231, 'Pelhřimov'],
  pisek:                  [49.3088, 14.1474, 'Písek'],
  prachatice:             [49.0122, 13.9986, 'Prachatice'],
  strakonice:             [49.2616, 13.9026, 'Strakonice'],
  tabor:                  [49.4144, 14.6578, 'Tábor'],
  domazlice:              [49.4406, 12.9247, 'Domažlice'],
  cheb:                   [50.0795, 12.3713, 'Cheb'],
  'karlovy vary':         [50.2317, 12.8714, 'Karlovy Vary'],
  klatovy:                [49.3953, 13.2950, 'Klatovy'],
  plzen:                  [49.7384, 13.3736, 'Plzeň'],
  rokycany:               [49.7434, 13.5953, 'Rokycany'],
  sokolov:                [50.1815, 12.6411, 'Sokolov'],
  tachov:                 [49.7945, 12.6378, 'Tachov'],
  decin:                  [50.7811, 14.2150, 'Děčín'],
  chomutov:               [50.4605, 13.4176, 'Chomutov'],
  most:                   [50.5031, 13.6361, 'Most'],
  litomerice:             [50.5340, 14.1346, 'Litoměřice'],
  louny:                  [50.3567, 13.7973, 'Louny'],
  teplice:                [50.6404, 13.8245, 'Teplice'],
  'usti nad labem':       [50.6607, 14.0327, 'Ústí nad Labem'],
  'ceska lipa':           [50.6850, 14.5378, 'Česká Lípa'],
  'jablonec nad nisou':   [50.7243, 15.1711, 'Jablonec nad Nisou'],
  liberec:                [50.7663, 15.0543, 'Liberec'],
  semily:                 [50.6027, 15.3320, 'Semily'],
  'hradec kralove':       [50.2092, 15.8328, 'Hradec Králové'],
  jicin:                  [50.4357, 15.3517, 'Jičín'],
  nachod:                 [50.4191, 16.1645, 'Náchod'],
  'rychnov nad kneznou':  [50.1626, 16.2737, 'Rychnov nad Kněžnou'],
  trutnov:                [50.5613, 15.9119, 'Trutnov'],
  chrudim:                [49.9512, 15.7959, 'Chrudim'],
  pardubice:              [50.0343, 15.7812, 'Pardubice'],
  svitavy:                [49.7563, 16.4697, 'Svitavy'],
  'usti nad orlici':      [49.9743, 16.3946, 'Ústí nad Orlicí'],
  'havlickuv brod':       [49.6076, 15.5807, 'Havlíčkův Brod'],
  jihlava:                [49.3961, 15.5912, 'Jihlava'],
  trebic:                 [49.2147, 15.8817, 'Třebíč'],
  'zdar nad sazavou':     [49.5613, 15.9396, 'Žďár nad Sázavou'],
  blansko:                [49.3608, 16.6427, 'Blansko'],
  brno:                   [49.1951, 16.6068, 'Brno'],
  breclav:                [48.7589, 16.8825, 'Břeclav'],
  hodonin:                [48.8493, 17.1326, 'Hodonín'],
  vyskov:                 [49.2776, 16.9978, 'Vyškov'],
  znojmo:                 [48.8555, 16.0488, 'Znojmo'],
  jesenik:                [50.2298, 17.2034, 'Jeseník'],
  olomouc:                [49.5938, 17.2509, 'Olomouc'],
  prostejov:              [49.4720, 17.1118, 'Prostějov'],
  prerov:                 [49.4552, 17.4509, 'Přerov'],
  sumperk:                [49.9650, 16.9708, 'Šumperk'],
  kromeriz:               [49.2986, 17.3933, 'Kroměříž'],
  'uherske hradiste':     [49.0697, 17.4602, 'Uherské Hradiště'],
  vsetin:                 [49.3389, 18.0001, 'Vsetín'],
  zlin:                   [49.2265, 17.6707, 'Zlín'],
  bruntal:                [49.9908, 17.4646, 'Bruntál'],
  'frydek-mistek':        [49.6839, 18.3505, 'Frýdek-Místek'],
  karvina:                [49.8546, 18.5419, 'Karviná'],
  'novy jicin':           [49.5944, 18.0136, 'Nový Jičín'],
  opava:                  [49.9387, 17.9026, 'Opava'],
  ostrava:                [49.8209, 18.2625, 'Ostrava'],
};

export function normalizeCityName(raw) {
  if (!raw) return '';
  let s = raw
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim().replace(/\s+/g, ' ');
  s = s.replace(/^(praha|prague)(\s+\d+)?$/, 'praha');
  s = s.replace(/^frydek[\s-]mistek$/, 'frydek-mistek');
  return s;
}

export function projectToMap(lat, lon) {
  const xFrac = (lon - MAP_BOUNDS.left) / (MAP_BOUNDS.right - MAP_BOUNDS.left);
  const yFrac = (MAP_BOUNDS.top - lat) / (MAP_BOUNDS.top - MAP_BOUNDS.bottom);
  return { xPct: xFrac * 100, yPct: yFrac * 100 };
}
