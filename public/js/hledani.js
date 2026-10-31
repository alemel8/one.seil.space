// Našeptávač globálního hledání v horní liště.
//
// Nad týmž backendem jako stránka /hledat (GET /api/hledat, 5 položek na
// skupinu). Od dvou znaků, debounce 250 ms; běžící požadavek se ruší
// a odpověď se starším dotazem zahazuje. Šipky, Enter a Esc; Enter bez
// výběru nechá formulář odejít na /hledat. Vykresluje se přes DOM API,
// ne innerHTML — výsledky nesou uživatelská data.
(function () {
  const pole = document.getElementById('hledaniPole');
  const form = pole?.closest('form');
  if (!pole || !form) return;

  // Panel pod polem: hláška „nic“ (role=status) a seznam voleb (role=listbox)
  // zvlášť — v listboxu smí být jen položky. Role combobox a aria-controls
  // má pole už v šabloně.
  const panel = document.createElement('div');
  panel.className = 'hledani-napoveda';
  panel.hidden = true;
  const prazdno = document.createElement('div');
  prazdno.className = 'hledani-napoveda-prazdno';
  prazdno.setAttribute('role', 'status');
  prazdno.hidden = true;
  const seznam = document.createElement('div');
  seznam.id = 'hledaniNapoveda';
  seznam.setAttribute('role', 'listbox');
  seznam.setAttribute('aria-label', 'Návrhy hledání');
  panel.append(prazdno, seznam);
  form.appendChild(panel);

  let casovac = null;
  let ridic = null;
  let polozky = [];
  let vybrana = -1;

  // Stejná normalizace jako na serveru — podle ní se pozná zastaralá odpověď.
  const normalizuj = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 100);

  // Zavření ruší i čekající dotaz — jinak by doběhlá odpověď seznam zase otevřela.
  function zavri() {
    clearTimeout(casovac);
    ridic?.abort();
    ridic = null;
    panel.hidden = true;
    pole.setAttribute('aria-expanded', 'false');
    pole.removeAttribute('aria-activedescendant');
    vybrana = -1;
  }

  function zvyrazni(i) {
    vybrana = i;
    polozky.forEach((el, j) => el.setAttribute('aria-selected', String(j === i)));
    if (i >= 0) {
      pole.setAttribute('aria-activedescendant', polozky[i].id);
      polozky[i].scrollIntoView({ block: 'nearest' });
    } else {
      pole.removeAttribute('aria-activedescendant');
    }
  }

  function polozka(href, trida) {
    const a = document.createElement('a');
    a.href = href;
    a.className = 'hledani-napoveda-polozka' + (trida ? ' ' + trida : '');
    a.setAttribute('role', 'option');
    a.id = 'hledaniPolozka' + polozky.length;
    a.addEventListener('mousemove', () => { if (vybrana !== polozky.indexOf(a)) zvyrazni(polozky.indexOf(a)); });
    seznam.appendChild(a);
    polozky.push(a);
    return a;
  }

  function vykresli(data) {
    seznam.replaceChildren();
    polozky = [];
    prazdno.hidden = data.skupiny.length > 0;
    prazdno.textContent = data.skupiny.length ? '' : `Nic nenalezeno pro „${data.q}“`;
    for (const g of data.skupiny) {
      for (const pol of g.polozky) {
        const a = polozka(pol.url);
        const skupina = document.createElement('span');
        skupina.className = 'badge badge-reselling hledani-napoveda-skupina';
        skupina.textContent = g.nazev;
        const titulek = document.createElement('span');
        titulek.className = 'hledani-napoveda-titulek';
        titulek.textContent = pol.titulek;
        a.append(skupina, titulek);
        if (pol.popis) {
          const popis = document.createElement('span');
          popis.className = 'hledani-napoveda-popis';
          popis.textContent = pol.popis;
          a.appendChild(popis);
        }
      }
    }
    const vse = polozka(`/hledat?q=${encodeURIComponent(data.q)}`, 'hledani-napoveda-vse');
    vse.textContent = `Všechny výsledky pro „${data.q}“ →`;
    vybrana = -1;
    panel.hidden = false;
    pole.setAttribute('aria-expanded', 'true');
  }

  async function hledej(q) {
    ridic?.abort();
    ridic = new AbortController();
    try {
      const res = await fetch(`/api/hledat?q=${encodeURIComponent(q)}`, { signal: ridic.signal, headers: { accept: 'application/json' } });
      if (!res.ok) return;
      const data = await res.json();
      if (data.q !== normalizuj(pole.value)) return;   // mezitím se psalo dál
      vykresli(data);
    } catch (e) {
      if (e.name !== 'AbortError') zavri();
    }
  }

  pole.addEventListener('input', () => {
    clearTimeout(casovac);
    const q = normalizuj(pole.value);
    if (q.length < 2) { zavri(); return; }
    casovac = setTimeout(() => hledej(q), 250);
  });

  pole.addEventListener('focus', () => {
    const q = normalizuj(pole.value);
    if (panel.hidden && q.length >= 2) hledej(q);
  });

  pole.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (panel.hidden) return;                  // Esc nad zavřeným seznamem nechat modalům
    if (e.key === 'ArrowDown') { e.preventDefault(); zvyrazni(Math.min(vybrana + 1, polozky.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); zvyrazni(Math.max(vybrana - 1, -1)); }
    else if (e.key === 'Enter' && vybrana >= 0) { e.preventDefault(); window.location.href = polozky[vybrana].href; }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); zavri(); }
  });

  document.addEventListener('click', (e) => { if (!form.contains(e.target)) zavri(); });
  form.querySelector('.topbar-hledani-zrusit')?.addEventListener('click', zavri);
})();
