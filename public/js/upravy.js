// Režim úprav na detailech: tužka → pole se otevřou na stránce → Uložit.
//
// Stav drží atribut data-rezim na obalu stránky (nebo karty); CSS podle něj
// ukáže buď hodnoty, nebo vstupy a buď tužku, nebo Zrušit/Uložit. Bez
// JavaScriptu totéž umí server přes ?upravit=1 (tužka i Zrušit jsou odkazy,
// Uložit je submit s form=). Skript jen přepíná atribut bez načtení stránky,
// drží URL pravdivou a hlídá rozepsané změny: Zrušit, Esc i odchod ze
// stránky se při změněném formuláři zeptají. Uložit nejdřív porovná formulář
// s čerstvě načtenou stránkou (viz „Kontrola při Uložit“), pak odešle nativně.
(function () {
  const obaly = Array.from(document.querySelectorAll('[data-rezim]'));
  if (!obaly.length) return;

  // Snímek formuláře při otevření – porovnáním poznáme neuložené změny.
  const snimky = new WeakMap();
  // Výjimka z hlídání odchodu pro jednu navigaci (odeslání, načtení skriptem).
  let odesilam = false;
  let odeslano = -Infinity;
  let prepnuto = -Infinity;
  // Běží kontrola při Uložit (dotaz na server před odesláním).
  let kontrola = false;
  let sitSelhala = false;
  const nacteno = Date.now();

  // sessionStorage nemusí být dostupný (soukromé okno, plná kvóta).
  const cti = (klic) => { try { return sessionStorage.getItem(klic); } catch { return null; } };
  const zapis = (klic, hodnota) => { try { sessionStorage.setItem(klic, hodnota); return true; } catch { return false; } };
  const smaz = (klic) => { try { sessionStorage.removeItem(klic); } catch { /* není co mazat */ } };

  // Formulář, který ovládání ukládá: ten, na který míří Uložit (form=).
  function formular(obal) {
    const tlacitko = obal.querySelector('.upravit-ulozit[form]');
    return (tlacitko && document.getElementById(tlacitko.getAttribute('form'))) || obal.querySelector('form.upravitelne');
  }
  const serializuj = (form) => new URLSearchParams(new FormData(form)).toString();
  const jeZmeneny = (obal) => {
    const form = formular(obal);
    return Boolean(form) && snimky.has(obal) && serializuj(form) !== snimky.get(obal);
  };
  const vUpravach = () => obaly.find(o => o.dataset.rezim === 'upravy');

  // URL bez reloadu: odkazy tužky a Zrušit nesou adresu daného režimu. F5 vrátí
  // úpravy a z adresy zmizí saved, error i ares, které už neplatí.
  function upravUrl(obal, upravy) {
    const odkaz = obal.querySelector(upravy ? '.upravit-otevrit' : '.upravit-zrusit');
    if (odkaz) history.replaceState(history.state, '', odkaz.href);
  }
  // Hláška z načtení stránky (Uloženo, chyba, ARES) po přepnutí režimu neplatí.
  const smazHlasky = () => document.querySelectorAll('[data-hlaska]').forEach(el => el.remove());
  function ohlas(obal, text) {
    const stav = obal.querySelector('.upravit-stav');
    if (stav) stav.textContent = text;
  }

  function otevri(obal) {
    const form = formular(obal);
    obal.dataset.rezim = 'upravy';
    prepnuto = performance.now();
    if (form) snimky.set(obal, serializuj(form));
    smazHlasky();
    upravUrl(obal, true);
    ohlas(obal, 'Režim úprav zapnut');
    const prvni = form && Array.from(form.elements).find(el =>
      !el.disabled && el.type !== 'hidden' && !['button', 'submit', 'reset'].includes(el.type) && el.offsetParent !== null);
    prvni?.focus();
  }

  function zavri(obal) {
    // Uložit už běží a doběhne i po zahození – stránka by pak hlásila Uloženo.
    if (kontrola || performance.now() - odeslano < 5000) return;
    if (jeZmeneny(obal) && !confirm('Zahodit neuložené změny?')) return;
    formular(obal)?.reset(); // vyvolá event reset – stránka si podle něj přepočítá, co inputy odvozují
    obal.dataset.rezim = 'zobrazeni';
    prepnuto = performance.now();
    snimky.delete(obal);
    smazHlasky();
    upravUrl(obal, false);
    ohlas(obal, 'Režim úprav vypnut');
    obal.querySelector('.upravit-otevrit')?.focus();
  }

  // Rozepsané hodnoty přežijí načtení stránky ze serveru: přesměrování s chybou
  // (?error=…&upravit=1) i nahrání dokladu by je jinak nahradily hodnotami
  // z databáze. Záznam platí jen pro první načtení, snímek zůstává ze serveru,
  // takže Zrušit i odchod se dál ptají a Zrušit vrátí uložený stav.
  //
  // Vrací se jen pole, která uživatel změnil proti snímku. Ostatní mají z načtení
  // čerstvé hodnoty: vrácení starých by přepsalo, co někdo mezitím uložil.
  // Klíč se počítá při použití: POST „Ověřit připojení“ vykreslí stránku na jiné cestě.
  const klicRozepsano = () => 'upravy-rozepsano:' + location.pathname;

  // Porovnává se proti snímku, ne proti defaultValue: prohlížeč hodnoty typu e-mail
  // a URL sám upravuje, takže by se lišily i bez zásahu uživatele.
  function zmenenaPole(form) {
    const obal = form.closest('[data-rezim]');
    if (!snimky.has(obal)) return [];
    const pred = new URLSearchParams(snimky.get(obal));
    const ted = new URLSearchParams(serializuj(form));
    return [...new Set([...pred.keys(), ...ted.keys()])]
      .filter(n => JSON.stringify(pred.getAll(n)) !== JSON.stringify(ted.getAll(n)));
  }
  function zapamatujRozepsane(form, poNacteni, navic = {}) {
    const zmenena = zmenenaPole(form);
    const ted = new URLSearchParams(serializuj(form));
    const hodnoty = new URLSearchParams();
    zmenena.forEach(n => ted.getAll(n).forEach(v => hodnoty.append(n, v)));
    return zapis(klicRozepsano(), JSON.stringify({ form: form.id, hodnoty: hodnoty.toString(), zmenena, poNacteni, ...navic }));
  }

  function doplnRozepsane(form, hodnoty, zmenena) {
    const h = new URLSearchParams(hodnoty);
    const jen = new Set(zmenena || []);
    Array.from(form.elements).forEach(el => {
      if (!jen.has(el.name) || ['hidden', 'submit', 'button', 'reset', 'file', 'password'].includes(el.type)) return;
      if (el.disabled && !h.has(el.name)) return; // vypnuté pole se neodesílá, není co vracet
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = h.getAll(el.name).includes(el.value);
      else if (h.has(el.name)) {
        // Volba, kterou mezitím někdo smazal: select by zůstal bez výběru a neodeslal se.
        const v = h.get(el.name);
        if (el.tagName !== 'SELECT' || Array.from(el.options).some(o => o.value === v)) el.value = v;
      }
      el.dispatchEvent(new Event('change', { bubbles: true })); // zámky a hinty skriptu stránky
    });
  }

  // ── Kontrola při Uložit ──
  // Routy přepisují všechny sloupce formuláře, takže stránka načtená před hodinami
  // by vrátila, co někdo mezitím změnil. Před odesláním se načte tatáž stránka znovu
  // a porovná se, co server vykreslil do formuláře tehdy a co teď. Změna ve sloupci,
  // který formulář nepíše (export do POHODY, příloha, stav faktury), tu není vidět
  // a správně: uložení ji nepřepíše.
  function vychoziStav(form) {
    const stav = {};
    for (const el of form.elements) {
      if (!el.name || ['submit', 'button', 'reset', 'image', 'file'].includes(el.type)) continue;
      const seznam = stav[el.name] || (stav[el.name] = []);
      if (el.type === 'checkbox' || el.type === 'radio') { if (el.defaultChecked) seznam.push(el.value); }
      else if (el.tagName === 'SELECT') {
        const moznosti = Array.from(el.options);
        const volba = moznosti.filter(o => o.defaultSelected).pop() || moznosti.find(o => !o.disabled);
        if (volba) seznam.push(volba.value);
      } else seznam.push(el.defaultValue);
    }
    return stav;
  }
  const stejne = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

  async function zkontroluj(form, tuzka) {
    const ctrl = new AbortController();
    const casovac = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(tuzka.href, { cache: 'no-store', signal: ctrl.signal });
      if (res.redirected && new URL(res.url).pathname === '/prihlasit') return { stav: 'prihlaseni' };
      if (res.status === 404) return { stav: 'smazano' };
      if (!res.ok) return { stav: 'neznamo' };
      const novy = new DOMParser().parseFromString(await res.text(), 'text/html').getElementById(form.id);
      if (!novy) return { stav: 'neznamo' };
      const a = vychoziStav(form), b = vychoziStav(novy);
      const zmeny = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(n => !stejne(a[n], b[n]));
      return { stav: zmeny.length ? 'konflikt' : 'shoda', zmeny };
    } catch (err) {
      // Spadlá síť: POST by skončil chybovou stránkou prohlížeče. Vypršel čas: server jen pomalu odpovídá.
      return { stav: err?.name === 'AbortError' ? 'neznamo' : 'sit' };
    } finally {
      clearTimeout(casovac);
    }
  }

  function hlaska(obal, text) {
    smazHlasky();
    const div = document.createElement('div');
    div.setAttribute('data-hlaska', '');
    div.setAttribute('role', 'alert');
    div.tabIndex = -1;
    div.style.cssText = 'background:var(--warning-bg);color:#92400E;border:1px solid #fde68a;padding:10px 16px;border-radius:8px;margin-bottom:16px;';
    div.textContent = text;
    const hlavicka = obal.querySelector('.page-header') || obal.querySelector('.card-header');
    if (hlavicka) hlavicka.after(div); else obal.prepend(div);
    div.focus();
  }

  const prvekPole = (form, jmeno) => { const el = form.elements[jmeno]; return el instanceof Element ? el : el?.[0]; };
  function popisekPole(form, jmeno) {
    const el = prvekPole(form, jmeno);
    return (el?.closest('.form-group')?.querySelector('.form-label')?.textContent || el?.labels?.[0]?.textContent || jmeno).trim();
  }
  // Co je teď uložené: výchozí hodnota prvku čerstvě načtené stránky.
  function ulozenaHodnota(form, jmeno) {
    const el = prvekPole(form, jmeno);
    if (el?.type === 'checkbox') return el.defaultChecked ? 'Ano' : 'Ne';
    if (el?.tagName === 'SELECT') {
      const moznosti = Array.from(el.options);
      return (moznosti.filter(o => o.defaultSelected).pop() || moznosti[0])?.textContent.trim() || 'nevyplněno';
    }
    const v = el?.defaultValue || 'nevyplněno';
    return v.length > 200 ? v.slice(0, 200) + '…' : v;
  }
  function ukazKonflikt(obal, form, r) {
    const pole = r.konflikt.map(n => popisekPole(form, n));
    const ted = new URLSearchParams(serializuj(form));
    const vychozi = vychoziStav(form);
    const kolize = r.konflikt.filter(n => r.zmenena.includes(n) && !stejne(ted.getAll(n), vychozi[n]));
    let text = `Záznam se mezitím změnil (možná v jiné kartě): ${pole.join(', ')}. Tato pole ukazují aktuální hodnotu, vaše úpravy zůstaly.`;
    if (kolize.length) {
      text = `Záznam se mezitím změnil (možná v jiné kartě): ${pole.join(', ')}. Ostatní pole ukazují aktuální hodnotu, vaše úpravy zůstaly. `
        + kolize.map(n => `${popisekPole(form, n)} jste měnili i vy: uloženo je „${ulozenaHodnota(form, n)}“, uložením ho přepíšete vaší hodnotou.`).join(' ');
    }
    hlaska(obal, `${text} Zkontrolujte údaje a klikněte znovu na Uložit.`);
    prepnuto = performance.now(); // druhý klik dvojkliku nesmí dopadnout na Uložit nové stránky
  }

  let rozepsano = null;
  try { rozepsano = JSON.parse(cti(klicRozepsano())); } catch { /* poškozený záznam se zahodí */ }
  smaz(klicRozepsano());

  // Serverem otevřené úpravy (?upravit=1) dostanou snímek hned při načtení.
  obaly.forEach(obal => {
    if (obal.dataset.rezim !== 'upravy') return;
    const form = formular(obal);
    if (!form) return;
    snimky.set(obal, serializuj(form));
    const zpet = performance.getEntriesByType?.('navigation')?.[0]?.type === 'back_forward';
    if (rozepsano?.form === form.id && (rozepsano.poNacteni || zpet || /[?&]error=/.test(location.search))) {
      doplnRozepsane(form, rozepsano.hodnoty, rozepsano.zmenena);
      if (rozepsano.konflikt) ukazKonflikt(obal, form, rozepsano);
    }
  });

  // Načtení stránky skriptem (po nahrání dokladu): rozepsané se vrátí do polí.
  // Když se nedají uložit, výjimka nevznikne a odchod se zeptá jako jindy.
  window.upravyNactiZnovu = () => {
    const obal = vUpravach();
    if (obal && jeZmeneny(obal) && zapamatujRozepsane(formular(obal), true)) odesilam = true;
    location.reload();
  };

  // Pojistka proti dvojkliku. Přepnutí režimu vymění tlačítka: pod tužkou leží
  // po otevření Uložit, pod Zrušit po zavření třeba Sync ARES nebo Smazat. Druhý
  // klik se pozná podle e.detail. Telefon dvě klepnutí za dvojklik počítat
  // nemusí, proto Uložit hlídá i čas: do půl sekundy po otevření se nic měnit
  // nestihlo. Hlídá se i mousedown, aby fokus zůstal v prvním poli.
  function pojistka(e) {
    const uplynulo = performance.now() - prepnuto;
    if ((e.detail >= 2 && uplynulo < 1000) || (uplynulo < 500 && e.target.closest?.('.upravit-ulozit'))) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  document.addEventListener('mousedown', pojistka, true);
  document.addEventListener('click', pojistka, true);

  document.addEventListener('click', e => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; // odkaz do nového panelu
    const otevrit = e.target.closest('[data-upravit-otevrit]');
    if (otevrit) {
      const obal = otevrit.closest('[data-rezim]');
      if (obal) { e.preventDefault(); otevri(obal); }
      return;
    }
    const zrusit = e.target.closest('[data-upravit-zrusit]');
    if (zrusit) {
      const obal = zrusit.closest('[data-rezim]');
      if (obal) { e.preventDefault(); zavri(obal); }
    }
  });

  // Esc = Zrušit, ale ne tam, kde Esc patří prvku samotnému (rozbalený
  // select, kalendář, našeptávač datalistu), ne přes otevřený modal – ten
  // zavírá app.js – a ne mimo upravovaný formulář (hledání v liště, heslo vedle
  // karty na profilu, token platformy). Bez capture, aby náhled dokladu
  // (doklad-nahled.js) mohl Esc dál zastavit u sebe. Posluchač vzniká dřív než
  // ten v app.js (ten až po DOMContentLoaded), takže otevřený modal je tu ještě
  // otevřený.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.isComposing) return;
    if (document.querySelector('.modal-backdrop.open')) return;
    const t = e.target;
    if (t && (t.tagName === 'SELECT' || (t.tagName === 'INPUT' && (t.type === 'date' || t.hasAttribute('list'))))) return;
    const obal = vUpravach();
    if (obal && (t === document.body || (obal.contains(t) && (!t.form || t.form === formular(obal))))) zavri(obal);
  });

  // Podržený Enter: po otevření tužkou klávesnicí se opakování přenese do prvního
  // pole a každé by odeslalo formulář. Odeslání nechává jen první stisk.
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.repeat && e.target.tagName === 'INPUT' && e.target.form?.classList.contains('upravitelne')) {
      e.preventDefault();
    }
  });

  function pripravOdeslani(form) {
    odesilam = true;
    odeslano = performance.now();
    zapamatujRozepsane(form, false);
  }
  // Událost submit už proběhla, druhá by jen spustila další kontrolu. Přes prototyp:
  // pole pojmenované „submit“ by metodu formuláře zakrylo.
  function odesli(form) {
    pripravOdeslani(form);
    HTMLFormElement.prototype.submit.call(form);
  }

  document.addEventListener('submit', e => {
    const form = e.target;
    if (!form.classList?.contains('upravitelne') || e.defaultPrevented) return;
    // Kontrola běží nebo už odešel POST: další klik nic nepřidá.
    if (kontrola || performance.now() - odeslano < 5000) { e.preventDefault(); return; }
    const obal = form.closest('[data-rezim]');
    const tuzka = obal?.querySelector('.upravit-otevrit');
    if (!tuzka) { pripravOdeslani(form); return; }

    e.preventDefault();
    kontrola = true;
    const tlacitka = Array.from(document.querySelectorAll(`.upravit-ulozit[form="${form.id}"]`));
    const popisky = tlacitka.map(b => b.textContent);
    tlacitka.forEach(b => { b.textContent = 'Ukládám…'; });
    const hotovo = () => { kontrola = false; tlacitka.forEach((b, i) => { b.textContent = popisky[i]; }); };

    zkontroluj(form, tuzka).then(({ stav, zmeny }) => {
      hotovo();
      if (stav === 'prihlaseni') return hlaska(obal, 'Přihlášení vypršelo. Přihlaste se v jiném panelu a klikněte znovu na Uložit, rozepsané údaje tu zůstávají.');
      // Jednou se zeptá znovu, podruhé odešle: kontrola nesmí Uložit zablokovat, ani když fetch trvale selhává.
      if (stav === 'sit' && !sitSelhala) { sitSelhala = true; return hlaska(obal, 'Server teď neodpovídá. Údaje zůstávají ve formuláři, zkuste uložit znovu.'); }
      if (stav === 'smazano') return hlaska(obal, 'Tento záznam mezitím někdo smazal, uložit už nejde.');
      if (stav !== 'konflikt') return odesli(form);
      // Pole, které se liší při každém načtení, by jinak uložení znemožnilo navždy.
      const pocet = (rozepsano?.pocet || 0) + 1;
      if (pocet >= 3 && confirm('Údaje se opakovaně mění. Přesto uložit a přepsat je?')) return odesli(form);
      if (!zapamatujRozepsane(form, true, { konflikt: zmeny, pocet })) {
        // Rozepsané nejde přenést přes načtení stránky (plné nebo vypnuté úložiště).
        if (confirm(`Záznam se mezitím změnil: ${zmeny.map(n => popisekPole(form, n)).join(', ')}. Přesto uložit a přepsat to?`)) odesli(form);
        return;
      }
      odesilam = true;
      location.replace(tuzka.href);
    }).catch(() => { hotovo(); odesli(form); }); // chyba v kontrole nesmí znemožnit uložení
  });

  // Návrat tlačítkem Zpět ze zásobníku stránek (bfcache) ukáže stránku tak, jak
  // ji uživatel opustil. Když se na téže adrese mezitím něco uložilo, má staré
  // výchozí hodnoty a další Uložit by uloženou změnu potichu vrátilo, proto se
  // načte znovu a bez úprav. Čas uložení zapisuje každá stránka s ?saved=.
  const klicUlozeni = 'upravy-ulozeno:' + location.pathname;
  if (/[?&]saved=/.test(location.search)) zapis(klicUlozeni, String(nacteno));

  window.addEventListener('pageshow', e => {
    odesilam = false;
    odeslano = -Infinity;
    kontrola = false;
    if (!e.persisted || !(Number(cti(klicUlozeni)) > nacteno)) return;
    const obal = vUpravach();
    if (obal) upravUrl(obal, false);
    odesilam = true;
    location.reload();
  });

  // Klik na záložku nebo zpět s rozepsaným formulářem – prohlížeč se zeptá.
  // Výjimka platí jednou: když uživatel odeslání zastaví (Stop), stránka zůstane
  // a další odchod se musí zeptat.
  window.addEventListener('beforeunload', e => {
    if (odesilam) { odesilam = false; return; }
    const obal = vUpravach();
    if (obal && jeZmeneny(obal)) { e.preventDefault(); e.returnValue = ''; }
  });
})();
