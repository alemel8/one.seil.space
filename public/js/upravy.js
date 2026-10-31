// Režim úprav na detailech: tužka → pole se otevřou na stránce → Uložit.
//
// Stav drží atribut data-rezim na obalu stránky (nebo karty); CSS podle něj
// ukáže buď hodnoty, nebo vstupy a buď tužku, nebo Zrušit/Uložit. Bez
// JavaScriptu totéž umí server přes ?upravit=1 (tužka i Zrušit jsou odkazy,
// Uložit je submit s form=). Skript jen přepíná atribut bez načtení stránky,
// drží URL pravdivou a hlídá rozepsané změny: Zrušit, Esc i odchod ze
// stránky se při změněném formuláři zeptají. Uložit je nativní submit.
(function () {
  const obaly = Array.from(document.querySelectorAll('[data-rezim]'));
  if (!obaly.length) return;

  // Snímek formuláře při otevření – porovnáním poznáme neuložené změny.
  const snimky = new WeakMap();
  // Výjimka z hlídání odchodu pro jednu navigaci (odeslání, načtení skriptem).
  let odesilam = false;
  let odeslano = -Infinity;
  let prepnuto = -Infinity;
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
    if (performance.now() - odeslano < 5000) return;
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
  const klicRozepsano = 'upravy-rozepsano:' + location.pathname;
  const zapamatujRozepsane = (form, poNacteni) =>
    zapis(klicRozepsano, JSON.stringify({ form: form.id, hodnoty: serializuj(form), poNacteni }));

  function doplnRozepsane(form, hodnoty) {
    const h = new URLSearchParams(hodnoty);
    Array.from(form.elements).forEach(el => {
      if (!el.name || ['hidden', 'submit', 'button', 'reset', 'file', 'password'].includes(el.type)) return;
      if (el.disabled && !h.has(el.name)) return; // vypnuté pole se neodesílá, není co vracet
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = h.getAll(el.name).includes(el.value);
      else if (h.has(el.name)) el.value = h.get(el.name);
      el.dispatchEvent(new Event('change', { bubbles: true })); // zámky a hinty skriptu stránky
    });
  }

  let rozepsano = null;
  try { rozepsano = JSON.parse(cti(klicRozepsano)); } catch { /* poškozený záznam se zahodí */ }
  smaz(klicRozepsano);

  // Serverem otevřené úpravy (?upravit=1) dostanou snímek hned při načtení.
  obaly.forEach(obal => {
    if (obal.dataset.rezim !== 'upravy') return;
    const form = formular(obal);
    if (!form) return;
    snimky.set(obal, serializuj(form));
    if (rozepsano?.form === form.id && (rozepsano.poNacteni || /[?&]error=/.test(location.search))) {
      doplnRozepsane(form, rozepsano.hodnoty);
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

  document.addEventListener('submit', e => {
    if (!e.target.classList?.contains('upravitelne')) return;
    odesilam = true;
    odeslano = performance.now();
    zapamatujRozepsane(e.target, false);
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
