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

  // Snímek formuláře při otevření — porovnáním poznáme neuložené změny.
  const snimky = new WeakMap();
  let odesilam = false;
  // Hláška z načtení stránky (Uloženo, chyba) se po zrušení úprav nemá vrátit.
  const maHlasku = /[?&](saved|error)=/.test(location.search);

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

  // URL bez reloadu: upravit=1 při otevření (ať F5 vrátí úpravy), bez něj po
  // zrušení; saved a error zmizí, aby nad otevřeným formulářem nesvítilo
  // „Uloženo“ nebo stará chyba.
  function upravUrl(upravy) {
    const url = new URL(location.href);
    if (upravy) { url.searchParams.set('upravit', '1'); url.searchParams.delete('saved'); }
    else { url.searchParams.delete('upravit'); url.searchParams.delete('error'); url.searchParams.delete('saved'); }
    history.replaceState(history.state, '', url);
  }
  function ohlas(obal, text) {
    const stav = obal.querySelector('.upravit-stav');
    if (stav) stav.textContent = text;
  }

  function otevri(obal) {
    const form = formular(obal);
    obal.dataset.rezim = 'upravy';
    if (form) snimky.set(obal, serializuj(form));
    upravUrl(true);
    ohlas(obal, 'Režim úprav zapnut');
    const prvni = form && Array.from(form.elements).find(el =>
      !el.disabled && el.type !== 'hidden' && !['button', 'submit', 'reset'].includes(el.type) && el.offsetParent !== null);
    prvni?.focus();
  }

  function zavri(obal) {
    if (jeZmeneny(obal) && !confirm('Zahodit neuložené změny?')) return;
    const form = formular(obal);
    form?.reset(); // vyvolá event reset — stránka si podle něj přepočítá, co inputy odvozují
    obal.dataset.rezim = 'zobrazeni';
    snimky.delete(obal);
    upravUrl(false);
    if (maHlasku) { location.reload(); return; } // URL už je bez saved/error, načte se čistá stránka
    ohlas(obal, 'Režim úprav vypnut');
    obal.querySelector('.upravit-otevrit')?.focus();
  }

  // Serverem otevřené úpravy (?upravit=1) dostanou snímek hned při načtení.
  obaly.forEach(obal => {
    if (obal.dataset.rezim !== 'upravy') return;
    const form = formular(obal);
    if (form) snimky.set(obal, serializuj(form));
  });

  document.addEventListener('click', e => {
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
  // select, kalendář, našeptávač datalistu), ne přes otevřený modal — ten
  // zavírá app.js — a ne mimo upravovaný obal (hledání v liště, heslo vedle
  // karty na profilu). Bez capture, aby náhled dokladu (doklad-nahled.js)
  // mohl Esc dál zastavit u sebe. Posluchač vzniká dřív než ten v app.js
  // (ten až po DOMContentLoaded), takže otevřený modal je tu ještě otevřený.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.isComposing) return;
    if (document.querySelector('.modal-backdrop.open')) return;
    const t = e.target;
    if (t && (t.tagName === 'SELECT' || (t.tagName === 'INPUT' && (t.type === 'date' || t.hasAttribute('list'))))) return;
    const obal = vUpravach();
    if (obal && (t === document.body || obal.contains(t))) zavri(obal);
  });

  document.addEventListener('submit', e => {
    if (e.target.classList?.contains('upravitelne')) odesilam = true;
  });

  // Návrat tlačítkem Zpět ze zásobníku stránek (bfcache): stránka žije dál,
  // ale žádné odesílání už neběží a hlídání změn musí znovu platit.
  window.addEventListener('pageshow', () => { odesilam = false; });

  // Klik na záložku nebo zpět s rozepsaným formulářem — prohlížeč se zeptá.
  window.addEventListener('beforeunload', e => {
    if (odesilam) return;
    const obal = vUpravach();
    if (obal && jeZmeneny(obal)) { e.preventDefault(); e.returnValue = ''; }
  });
})();
