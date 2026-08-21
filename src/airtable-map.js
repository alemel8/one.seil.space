// Převod záznamů z Airtable na řádky pro PostgreSQL.
//
// Čisté funkce bez databáze i bez sítě — jádro migrace se tak dá otestovat
// na skutečných odpovědích z API, aniž by se něco kamkoli zapisovalo.
//
// Pole se čtou přes ID, ne přes název (returnFieldsByFieldId=true). Kdyby se
// sloupec v Airtable přejmenoval, import to nerozbije.

export const TABULKY = {
  podklady:    'tblpvABCTR0afRzZF',
  mzdy:        'tblDAOXFI2Ae3jKBy',
  extra:       'tblj2XyBFMI4NMFtV',
  dokumenty:   'tblpmrSONl35jRNoP',
  tasks:       'tbl5q7NpcM0tz8Ru4',
  timetracker: 'tblCbIrkDvr3wCaw3',
  payroll:     'tblBeO1F5Gk7qQIOw',
  users:       'tblqyqtIGSdAqrEJD',
};

const F = {
  podklad: {
    oznaceni: 'fldsurfhjtQOdwJnc', projekty: 'fldpCbHTtztlEbaF3', lokality: 'fldjrK1Xnotnk2lIf',
    rozpisPrace: 'fldsy5PHZkNgKBiPP', vydajoveDoklady: 'fldWCeLISQa2cm13A',
    rozpisText: 'flddqC7b7reh4eiK7', castka: 'fldwkXqoaDEhcNGRN',
    faktura: 'fldOsfb4NsbqbvqoK', status: 'fldL0ZgmgXvq2fzn6', datum: 'fldHuTEdPbGJKs6QR',
  },
  mzda: {
    mesic: 'fldn4EzhwYLVLIZe9', rok: 'fldqvesYDwN3ynYv2',
    paska: 'fldOeVt58SxjTEgky', rozpis: 'fldHfFNNyhodUKzHu',
    nakladyFirmy: 'fldtN3ELHIW04YSXx', hruba: 'fldXl8F5pyddnO2kc',
    socialni: 'fld0aNTM8i5WK2FYU', zdravotni: 'fldw3XK3322IyV6qW',
    insolvence: 'fldM6wkPJrX3XzFm2', exekuce: 'fldfVc3MzY5wGxxJr',
    fu: 'fldHPfgoAEyg7tUnx', kooperativa: 'fldGNcaeCeeMOlLtn',
    cista: 'fldIqeQmZaGzDJIM4', uhrazeno: 'fld0j33q7oymWKHnt',
    vyplaceno: 'fld7UjWNKcDwuBl3c', vytvoreno: 'fld6SkA4OO8PK7WC0',
  },
  extra:    { datum: 'fldz9xhiT1oSKQziC', poznamka: 'fldD5wjw6j1UZMydY', castka: 'fldC5KInyTYPwxjJx' },
  dokument: { nazev: 'fldO8GUdkzmHa0hQC', kategorie: 'flddo83yR5pdchLrL',
              soubor: 'fldDg1GJp4RoAogYw', status: 'fldt89b01ZIFehy5n', datum: 'fldjY99OReDMZ1UbH' },
  task: {
    kod: 'fldR5wi6LCr0GrA08', seq: 'fldg698HzUfKJ8N0d', klient: 'fldAsEDt9NTPElLjY',
    typ: 'fldy9D5bt5DKfVT4l', status: 'fldEcrVbiUhRQc5nl', priorita: 'fldBwmn89GQ03mn72',
    souhrn: 'fldJCoZsUN50dhtD0', popis: 'fldQ2RpXogoOrLopC',
    nadrazeny: 'fldadlNNK82GmLpGT', start: 'fldEBOXolHzl5vQ5k', termin: 'fldpUbAPNtLi9Dghs',
    dokonceno: 'fld5oIlnLLelYn3pG', priloha: 'fldVAsHTqMYDEkItv',
    autor: 'fldj1riYHg9GvzFko', resitel: 'fldkbUsazPvqkDR4r',
  },
  cas: { ukol: 'fld5ONJqegpDX9O2w', typ: 'fldmMRhykwyUIFz86',
         start: 'fldXfOBDCr9KhYyKD', konec: 'fldtvueGogE87VyN8', uzivatel: 'fldDS44uUNJTekXmG' },
  payroll: {
    zamestnanec: 'fldERu5xLB6eqapeg', sazba: 'fldYY5tGdxEeLENv3',
    zacatekMesice: 'fldGoBhsBR3ors3fb', hodiny: 'fldd7enwrQ4sIPp1r',
    odmena: 'fldwR0wVBz5PfUVHp', hruba: 'fldUPt2gygHqtOrDH',
    hotovost: 'fldoMQLJTOYOgWSaz', extraBonus: 'fld9XvhXBN6VKfKFO',
    poznamka: 'fldANpFgwBzqgKvYw', prilohy: 'fld9dI2tIWj5QoH8K',
  },
  user: { email: 'fldAdVbRyUea1zvkL', jmeno: 'fldiCbHxvRtCYpgNd',
          prijmeni: 'fldbsioEBbeHYMw1X', sazba: 'fldTjE0QVVMca1pMA' },
};

// ── drobní pomocníci ─────────────────────────────────────────

const MESICE = ['leden','únor','březen','duben','květen','červen',
                'červenec','srpen','září','říjen','listopad','prosinec'];

/** České jméno měsíce na číslo. „Červen" a „Červenec" se liší až na osmém znaku. */
export function cisloMesice(nazev) {
  const n = String(nazev ?? '').trim().toLowerCase();
  const i = MESICE.indexOf(n);
  return i === -1 ? null : i + 1;
}

function pole(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** singleSelect přijde jako {id,name}, multipleSelects jako pole objektů. */
function jmenaVoleb(v) {
  return pole(v).map(x => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
}

function jednaVolba(v) {
  return typeof v === 'string' ? v : v?.name ?? null;
}

function cislo(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function datum(v) {
  const s = String(v ?? '');
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** Přílohy záznamu v pořadí, jak jsou v Airtable. */
export function prilohy(rec, fieldId, kategorie) {
  return pole(rec.cellValuesByFieldId?.[fieldId] ?? rec.fields?.[fieldId])
    .filter(a => a && a.url)
    .map((a, i) => ({
      airtableId: a.id, url: a.url, filename: a.filename || 'priloha',
      mime: a.type || 'application/octet-stream', size: a.size || 0,
      kategorie, poradi: i,
    }));
}

const bunky = rec => rec.cellValuesByFieldId ?? rec.fields ?? {};

// ── fakturační podklady ──────────────────────────────────────

const PODKLAD_STAV = { 'Odesláno': 'odeslano', 'Zpracovává se': 'rozpracovano', 'Vyfakturováno': 'fakturovano' };

/** Číslo faktury z názvu PDF: Faktura_25240001.pdf → 25240001. */
export function cisloFakturyZNazvu(filename) {
  const m = /^faktura[_\s-]*(\d{6,12})/i.exec(String(filename ?? '').trim());
  return m ? m[1] : '';
}

export function mapujPodklad(rec) {
  const c = bunky(rec);
  const fakturaPriloha = prilohy(rec, F.podklad.faktura, 'vystavena_faktura')[0] ?? null;
  return {
    airtableId: rec.id,
    title: jednaVolba(c[F.podklad.oznaceni]) ?? String(c[F.podklad.oznaceni] ?? ''),
    reportDate: datum(c[F.podklad.datum]) ?? datum(rec.createdTime),
    breakdown: String(c[F.podklad.rozpisText] ?? ''),
    totalAmount: cislo(c[F.podklad.castka]),
    status: PODKLAD_STAV[jednaVolba(c[F.podklad.status])] ?? 'odeslano',
    // Vícehodnotové: jeden podklad pokrývá i tři zakázky ve dvou zemích.
    // Nečte se z formule „Označení" — u vícehodnotových ji nejde rozebrat zpět.
    projekty: jmenaVoleb(c[F.podklad.projekty]),
    lokality: jmenaVoleb(c[F.podklad.lokality]).map(rozdelLokalitu),
    invoiceNumber: fakturaPriloha ? cisloFakturyZNazvu(fakturaPriloha.filename) : '',
    fakturaPriloha,
    prilohy: [
      ...prilohy(rec, F.podklad.rozpisPrace, 'rozpis_prace'),
      ...prilohy(rec, F.podklad.vydajoveDoklady, 'vydajovy_doklad'),
    ],
  };
}

/** „Singapore, Singapore" → město + země. Dělí se na POSLEDNÍ čárce. */
export function rozdelLokalitu(text) {
  const s = String(text ?? '').trim();
  const i = s.lastIndexOf(',');
  return i === -1 ? { city: s, country: '' }
                  : { city: s.slice(0, i).trim(), country: s.slice(i + 1).trim() };
}

// ── mzdový rozpis ────────────────────────────────────────────

/** Kategorie přílohy z názvu souboru — balíček od účetní má stabilní názvy. */
export function kategoriePrilohyMzdy(filename) {
  const n = String(filename ?? '').toLowerCase();
  if (/\.xml$/.test(n) || /cssz|čssz|mh-\d/.test(n)) return 'epodani_cssz';
  if (/p[rř][ií]kaz|qr/.test(n))                     return 'prikaz_k_uhrade';
  if (/v[yý]platnice|v[yý]platn[ií].*p[aá]sk/.test(n)) return 'vyplatni_paska';
  return 'mzdovy_rozpis';
}

export function mapujMzdu(rec) {
  const c = bunky(rec);
  const m = cisloMesice(jednaVolba(c[F.mzda.mesic]));
  const rok = parseInt(jednaVolba(c[F.mzda.rok]) ?? '', 10);
  const period = m && rok ? `${rok}-${String(m).padStart(2, '0')}-01` : null;

  return {
    airtableId: rec.id,
    period,
    gross: cislo(c[F.mzda.hruba]),
    net: cislo(c[F.mzda.cista]),
    social: cislo(c[F.mzda.socialni]),
    health: cislo(c[F.mzda.zdravotni]),
    tax: cislo(c[F.mzda.fu]),
    insolvency: cislo(c[F.mzda.insolvence]),
    garnishment: cislo(c[F.mzda.exekuce]),
    accidentInsurance: cislo(c[F.mzda.kooperativa]),
    companyCost: cislo(c[F.mzda.nakladyFirmy]),
    // UHRAZENO je v cíli generovaný sloupec; hodnotu z Airtable si vezmeme
    // jen na kontrolu, že dopočet sedí.
    uhrazenoAirtable: cislo(c[F.mzda.uhrazeno]),
    paid: Boolean(c[F.mzda.vyplaceno]),
    paidOn: datum(c[F.mzda.vytvoreno]) ?? datum(rec.createdTime),
    prilohy: [
      ...prilohy(rec, F.mzda.paska, 'vyplatni_paska'),
      ...prilohy(rec, F.mzda.rozpis, 'mzdovy_rozpis')
        .map(p => ({ ...p, kategorie: kategoriePrilohyMzdy(p.filename) })),
    ],
  };
}

/** Kontrola, že dopočtené UHRAZENO sedí na to z Airtable. */
export function kontrolaUhrazeno(m) {
  const dopocet = m.net + m.social + m.health + m.garnishment
                + m.tax + m.insolvency + m.accidentInsurance;
  return { dopocet, sedi: Math.abs(dopocet - m.uhrazenoAirtable) < 0.01 };
}

// ── platby mimo mzdu ─────────────────────────────────────────

export function mapujExtraVydaj(rec) {
  const c = bunky(rec);
  return {
    airtableId: rec.id,
    paidOn: datum(c[F.extra.datum]) ?? datum(rec.createdTime),
    amount: cislo(c[F.extra.castka]),
    description: String(c[F.extra.poznamka] ?? '').trim(),
    // Všechno jako záloha. Zálohu od proplaceného nákladu nejde z dat
    // spolehlivě poznat (u dvanácti záznamů je poznámka prázdná) a špatné
    // zařazení by posunulo hrubý zisk o desítky tisíc. Druh se překlikne v UI.
    kind: 'zaloha',
  };
}

// ── dokumenty ────────────────────────────────────────────────

// Na pořadí záleží: „DODATEK Č.1 PRACOVNÍ SMLOUVY" obsahuje obojí, takže
// specifičtější vzor musí být první, jinak z dodatku vyjde smlouva.
const KATEGORIE_PODLE_NAZVU = [
  [/dodatek/i,                     'Dodatek smlouvy'],
  [/pracovn[ií]\s*smlouv/i,        'Pracovní smlouva'],
  [/mzdov[yý]\s*v[yý]m[eě]r/i,     'Mzdový výměr'],
  [/ozn[aá]men[ií]/i,              'Oznámení'],
  [/registrace/i,                  'Registrace'],
  [/p[rř]ihl[aá][sš]k/i,           'Přihláška'],
  [/prohl[aá][sš]en[ií]/i,         'Prohlášení'],
];

/** Kategorie z názvu — v Airtable je vyplněná jen u tří záznamů z deseti. */
export function kategorieDokumentu(nazev, zAirtable) {
  if (zAirtable) return zAirtable;
  for (const [re, kat] of KATEGORIE_PODLE_NAZVU) if (re.test(String(nazev ?? ''))) return kat;
  return '';
}

export function mapujDokument(rec) {
  const c = bunky(rec);
  const nazev = String(c[F.dokument.nazev] ?? '').trim();
  return {
    airtableId: rec.id,
    title: nazev || 'Dokument',
    category: kategorieDokumentu(nazev, jednaVolba(c[F.dokument.kategorie])),
    documentDate: datum(c[F.dokument.datum]) ?? datum(rec.createdTime),
    signed: Boolean(c[F.dokument.status]),
    prilohy: prilohy(rec, F.dokument.soubor, 'smluvni_dokument'),
  };
}

// ── úkoly a čas ──────────────────────────────────────────────

const TASK_STAV = { 'Todo': 'todo', 'In progress': 'in_progress', 'Done': 'done',
                    'Testing': 'testing', 'On hold': 'on_hold' };

function slug(text) {
  return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'ukol';
}

export function mapujUkol(rec) {
  const c = bunky(rec);
  const prio = jednaVolba(c[F.task.priorita]);
  const prioCislo = prio ? parseInt(prio, 10) : null;
  return {
    airtableId: rec.id,
    code: jednaVolba(c[F.task.kod]) ?? String(c[F.task.kod] ?? '') ?? null,
    seq: c[F.task.seq] ?? null,
    kind: slug(jednaVolba(c[F.task.typ]) ?? 'úkol'),
    status: TASK_STAV[jednaVolba(c[F.task.status])] ?? 'todo',
    priority: Number.isInteger(prioCislo) && prioCislo >= 1 && prioCislo <= 10 ? prioCislo : null,
    priorityLabel: (prio ?? '').trim(),
    summary: String(c[F.task.souhrn] ?? '').trim(),
    description: String(c[F.task.popis] ?? ''),
    startDate: datum(c[F.task.start]),
    dueDate: datum(c[F.task.termin]),
    doneAt: c[F.task.dokonceno] ?? null,
    klientAirtableId: pole(c[F.task.klient])[0]?.id ?? null,
    nadrazenyAirtableId: pole(c[F.task.nadrazeny])[0]?.id ?? null,
    autorAirtableId: pole(c[F.task.autor])[0]?.id ?? null,
    resitelAirtableId: pole(c[F.task.resitel])[0]?.id ?? null,
    prilohy: prilohy(rec, F.task.priloha, 'priloha_ukolu'),
  };
}

export function mapujMereni(rec) {
  const c = bunky(rec);
  return {
    airtableId: rec.id,
    startedAt: c[F.cas.start] ?? null,
    endedAt: c[F.cas.konec] ?? null,
    kind: jednaVolba(c[F.cas.typ]) === 'Meeting' ? 'meeting' : 'task',
    ukolAirtableId: pole(c[F.cas.ukol])[0]?.id ?? null,
    uzivatelAirtableId: pole(c[F.cas.uzivatel])[0]?.id ?? null,
  };
}

// ── Heříkova mzdová tabulka ──────────────────────────────────

/**
 * Rozdělí řádek Payroll na mzdu nebo proplacený nákup.
 * Airtable je mísil: řádky s Extra Bonusem jsou nákupy (tablet, sluchátka,
 * O2 tarif) s fakturou v příloze, zbytek jsou mzdy. Rozhoduje se podle dat,
 * ne podle seznamu názvů — nová položka by jinak propadla.
 */
export function mapujPayroll(rec) {
  const c = bunky(rec);
  const extraBonus = cislo(c[F.payroll.extraBonus]);
  const hodiny = c[F.payroll.hodiny] == null ? null : cislo(c[F.payroll.hodiny]);
  const hruba = cislo(c[F.payroll.hruba]);
  const hotovost = cislo(c[F.payroll.hotovost]);
  const period = datum(c[F.payroll.zacatekMesice]);
  const poznamka = String(c[F.payroll.poznamka] ?? '').trim();
  const lookup = c[F.payroll.sazba];
  const sazba = cislo(
    lookup?.valuesByLinkedRecordId
      ? Object.values(lookup.valuesByLinkedRecordId)[0]?.[0]
      : pole(lookup)[0]
  );

  const spolecne = {
    airtableId: rec.id, period, poznamka,
    uzivatelAirtableId: pole(c[F.payroll.zamestnanec])[0]?.id ?? null,
    prilohy: prilohy(rec, F.payroll.prilohy, 'doklad_o_nakupu'),
  };

  if (extraBonus > 0) {
    return { ...spolecne, druh: 'naklad', amount: extraBonus,
             description: poznamka || 'Proplacený náklad' };
  }
  if (hodiny || hruba || hotovost) {
    return { ...spolecne, druh: 'mzda', hours: hodiny, hourlyRate: sazba || null,
             earned: hodiny != null ? hodiny * sazba : null, gross: hruba, cashPaid: hotovost,
             prilohy: spolecne.prilohy.map(p => ({ ...p, kategorie: 'mzdovy_rozpis' })) };
  }
  return { ...spolecne, druh: 'prazdny' };
}

export function mapujUzivatele(rec) {
  const c = bunky(rec);
  return {
    airtableId: rec.id,
    email: String(c[F.user.email] ?? '').trim().toLowerCase(),
    // Jména v Airtable mají místy úvodní mezeru z formule
    jmeno: String(c[F.user.jmeno] ?? '').trim(),
    prijmeni: String(c[F.user.prijmeni] ?? '').trim(),
    hourlyRate: c[F.user.sazba] == null ? null : cislo(c[F.user.sazba]),
  };
}

export const POLE = F;
