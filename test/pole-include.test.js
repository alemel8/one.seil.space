// Include views/includes/pole.ejs (jedno pole detailu v režimu zobrazení
// i úprav) bez serveru a databáze: vykreslí se přímo přes EJS. Hlídá, že
// hodnota i vstup jsou v HTML oba, že se všechno escapuje a že datum, select
// a přepínač dávají správný text i hodnotu vstupu.
//
//   node --test test/pole-include.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { jenDatum, ceskeDatum } from '../src/prazsky-cas.js';

const sablona = fileURLToPath(new URL('../views/includes/pole.ejs', import.meta.url));
const vykresli = (pole) => ejs.renderFile(sablona, { pole, jenDatum, ceskeDatum });

test('textové pole: popisek, hodnota i vstup, všechno escapované', async () => {
  const html = await vykresli({ label: 'Název', name: 'name', value: 'Dílna <b>Vlněnka</b> & spol.', required: true, maxlength: 100, placeholder: 'x"y' });
  assert.match(html, /<label class="form-label required" for="pole-name">Název<\/label>/);
  assert.match(html, /<div class="pole-hodnota">Dílna &lt;b&gt;Vlněnka&lt;\/b&gt; &amp; spol\.<\/div>/);
  assert.match(html, /<input type="text" class="form-control" value="Dílna &lt;b&gt;Vlněnka&lt;\/b&gt; &amp; spol\." id="pole-name" name="name" required placeholder="x&quot;y" maxlength="100" pattern="\.\*\\S\.\*" title="Pole nesmí být prázdné">/, 'povinné textové pole odmítne i samé mezery');
  assert.ok(!html.includes('<b>'), 'surové HTML z hodnoty se nevykreslí');
});

test('prázdná hodnota ukáže pomlčku s textem pro čtečku, vstup zůstane prázdný', async () => {
  for (const value of ['', null, undefined]) {
    const html = await vykresli({ label: 'Web', name: 'website', typ: 'url', value });
    assert.match(html, /<span class="pole-prazdne">–<span class="sr-only"> nevyplněno<\/span><\/span>/);
    assert.match(html, /<input type="url" class="form-control" value="" id="pole-website" name="website">/);
  }
});

test('url, e-mail a telefon jsou v zobrazení odkazy; url jen s http(s)', async () => {
  let html = await vykresli({ label: 'Web', name: 'website', typ: 'url', value: 'https://seil.cz/?a=1&b=2' });
  assert.match(html, /<a href="https:\/\/seil\.cz\/\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">https:\/\/seil\.cz\/\?a=1&amp;b=2<\/a>/);
  html = await vykresli({ label: 'Web', name: 'website', typ: 'url', value: 'javascript:alert(1)' });
  assert.ok(!html.includes('<a '), 'nebezpečné schéma není odkaz');
  assert.ok(html.includes('javascript:alert(1)'), 'ale hodnota je vidět jako text');
  html = await vykresli({ label: 'E-mail', name: 'email', typ: 'email', value: 'ahoj@seil.cz' });
  assert.match(html, /<a href="mailto:ahoj@seil\.cz">ahoj@seil\.cz<\/a>/);
  for (const nebezpecny of ['ahoj@seil.cz?bcc=x@y.cz', 'a@b.cz,c@d.cz', 'a@b.cz&subject=x', 'bez-zavinace']) {
    html = await vykresli({ label: 'E-mail', name: 'email', typ: 'email', value: nebezpecny });
    assert.ok(!html.includes('mailto:'), `${nebezpecny}: mailto by přidal příjemce nebo předvyplněný text`);
    assert.ok(html.includes(nebezpecny.replace(/&/g, '&amp;')), 'hodnota zůstane vidět jako text');
  }
  html = await vykresli({ label: 'Telefon', name: 'phone', typ: 'tel', value: '+420 728 749 931' });
  assert.match(html, /<a href="tel:\+420728749931">\+420 728 749 931<\/a>/);
});

test('datum: vstup YYYY-MM-DD, zobrazení česky, nezávisle na typu hodnoty', async () => {
  for (const value of [new Date('2026-03-05T00:00:00Z'), '2026-03-05', '2026-03-05T00:00:00.000Z']) {
    const html = await vykresli({ label: 'Od', name: 'since', typ: 'date', value });
    assert.match(html, /<div class="pole-hodnota">5\. 3\. 2026<\/div>/);
    assert.match(html, /<input type="date" class="form-control" value="2026-03-05"/);
  }
  const html = await vykresli({ label: 'Od', name: 'since', typ: 'date', value: null });
  assert.match(html, /pole-prazdne/);
  assert.match(html, /<input type="date" class="form-control" value=""/);
});

test('select: popisek vybrané možnosti, porovnání jako řetězec, prázdná volba', async () => {
  let html = await vykresli({ label: 'E-shop', name: 'shop_id', typ: 'select', value: 7, prazdna: '– žádný –', moznosti: [[7, 'Toneráček'], [8, 'Vlněnka']] });
  assert.match(html, /<div class="pole-hodnota">Toneráček<\/div>/);
  assert.match(html, /<option value="7" selected>Toneráček<\/option>/);
  assert.match(html, /<option value="8">Vlněnka<\/option>/);
  assert.match(html, /<option value="">– žádný –<\/option>/);
  html = await vykresli({ label: 'E-shop', name: 'shop_id', typ: 'select', value: null, prazdna: '– žádný –', moznosti: ['A', 'B'] });
  assert.match(html, /pole-prazdne/);
  assert.match(html, /<option value="" selected>– žádný –<\/option>/);
  assert.match(html, /<option value="A">A<\/option>/);
});

test('přepínač a zaškrtávátko: Ano/Ne nebo vlastní text, value="1", checked podle hodnoty', async () => {
  let html = await vykresli({ label: 'Stav', name: 'active', typ: 'toggle', value: true, popisek: 'Aktivní e-shop', zobraz: 'Aktivní', disabled: true });
  assert.match(html, /<span class="form-label">Stav<\/span>/, 'popisek pole není <label> – ten patří přepínači');
  assert.match(html, /<div class="pole-hodnota">Aktivní<\/div>/);
  assert.match(html, /<input type="checkbox" class="toggle-input" value="1" id="pole-active" name="active" disabled checked>/);
  assert.match(html, /<span class="toggle-text">Aktivní e-shop<\/span>/);
  html = await vykresli({ label: 'Plátce DPH', name: 'vat_payer', typ: 'checkbox', value: false, hodnotaVstupu: 'on' });
  assert.match(html, /<div class="pole-hodnota">Ne<\/div>/);
  assert.match(html, /<input type="checkbox" value="on" id="pole-vat_payer" name="vat_payer">/);
});

test('textarea a číslo', async () => {
  let html = await vykresli({ label: 'Poznámky', name: 'notes', typ: 'textarea', value: 'řádek 1\nřádek <2>', rows: 5 });
  assert.match(html, /<div class="pole-hodnota pole-hodnota-blok">řádek 1\nřádek &lt;2&gt;<\/div>/);
  assert.match(html, /<textarea class="form-control" rows="5" id="pole-notes" name="notes">řádek 1\nřádek &lt;2&gt;<\/textarea>/);
  html = await vykresli({ label: 'Marže', name: 'pct', typ: 'number', value: 28.5, step: '0.01', min: 0, max: 100 });
  assert.match(html, /<div class="pole-hodnota">28,5<\/div>/);
  assert.match(html, /<input type="number" class="form-control" value="28.5" id="pole-pct" name="pct" min="0" max="100" step="0.01">/);
});

test('form=, vlastní id, hint jen v úpravách a pole jen pro čtení', async () => {
  let html = await vykresli({ label: 'Kategorie', name: 'category', id: 'rdCategory', form: 'formUctenka', typ: 'select', value: 'Ostatní', moznosti: ['Ostatní'], hint: 'Nápověda <i>' });
  assert.match(html, /<label class="form-label" for="rdCategory">Kategorie<\/label>/);
  assert.match(html, /<select class="form-select" id="rdCategory" name="category" form="formUctenka">/);
  assert.match(html, /<small class="form-hint jen-upravy">Nápověda &lt;i&gt;<\/small>/);
  html = await vykresli({ label: 'E-mail', name: 'email', value: 'a@b.cz', stale: true, hint: 'E-mail nelze změnit' });
  assert.match(html, /<div class="form-group pole pole-stale">/);
  assert.ok(!html.includes('<input'), 'pole jen pro čtení nemá vstup');
  assert.match(html, /<div class="pole-hodnota">a@b\.cz<\/div>/);
  html = await vykresli({ label: 'Adresa', name: 'address', value: '', trida: 'col-span-2', styl: 'grid-column:1/-1' });
  assert.match(html, /<div class="form-group pole col-span-2" style="grid-column:1\/-1">/);
});

test('výchozí hodnota jen pro vstup, třídy hodnoty a skrytý popisek', async () => {
  let html = await vykresli({ label: 'Stát', name: 'country', value: '', vychozi: 'Česká republika' });
  assert.match(html, /pole-prazdne/, 'prázdná hodnota se v zobrazení nepředstírá');
  assert.match(html, /<input type="text" class="form-control" value="Česká republika"/, 'vstup má výchozí hodnotu');
  html = await vykresli({ label: 'Stát', name: 'country', value: 'Slovensko', vychozi: 'Česká republika' });
  assert.match(html, /<div class="pole-hodnota">Slovensko<\/div>/);
  assert.match(html, /value="Slovensko"/);

  html = await vykresli({ label: 'IČO', name: 'ico', value: '12345678', tridaHodnoty: 'pole-mono' });
  assert.match(html, /<div class="pole-hodnota pole-mono">12345678<\/div>/);

  html = await vykresli({ label: 'Poznámky', name: 'notes', typ: 'textarea', value: 'x', skrytyPopisek: true });
  assert.match(html, /<label class="form-label sr-only" for="pole-notes">Poznámky<\/label>/, 'popisek zůstává pro čtečku');
});

test('select: hodnota mimo nabídku zůstane vybraná, aby ji uložení nepřepsalo', async () => {
  const html = await vykresli({ label: 'Stav', name: 'status', typ: 'select', value: 'V přípravě', moznosti: ['Aktivní', 'Pozastaveno'] });
  assert.match(html, /<div class="pole-hodnota">V přípravě<\/div>/);
  assert.match(html, /<option value="V přípravě" selected>V přípravě<\/option>/);
  assert.match(html, /<option value="Aktivní">Aktivní<\/option>/, 'první volba nabídky vybraná není');
});

test('každý formulář režimu úprav má autocomplete="off", jinak prohlížeč po F5 a Zpět vrátí staré hodnoty', () => {
  const views = fileURLToPath(new URL('../views/', import.meta.url));
  let pocet = 0;
  for (const soubor of readdirSync(views, { recursive: true })) {
    if (!String(soubor).endsWith('.ejs')) continue;
    // Regex na celou značku <form> by se zastavil na > uvnitř <%= %>.
    for (const m of readFileSync(views + soubor, 'utf8').matchAll(/class="[^"]*\bupravitelne\b[^"]*"(.{0,20})/g)) {
      pocet++;
      assert.match(m[1], /^ autocomplete="off"/, `${soubor}: ${m[0]}`);
    }
  }
  assert.ok(pocet >= 14, `našlo se jen ${pocet} formulářů`);
});
