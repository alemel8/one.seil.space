// Přehledy e-shopů (objednávky, marketing): čísla se při načtení dopočítají
// nahoru a klik na dlaždici, filtr nebo řádek ukáže pruh načítání, než
// server pošle další stránku. Obsah je hotový už v HTML – skript jen
// animuje, bez něj (nebo s omezeným pohybem) je vidět rovnou výsledek.
(function () {
  var html = document.documentElement;
  var klid = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Dopočítání čísel ──────────────────────────────────────
  // <span data-pocitadlo="1234.5" data-desetin="2" data-pripona=" Kč">1 234,50 Kč</span>
  function format(v, desetin, pripona) {
    return v.toLocaleString('cs-CZ', { minimumFractionDigits: desetin, maximumFractionDigits: desetin }) + pripona;
  }

  function dopocitej(el) {
    var cil = Number(el.getAttribute('data-pocitadlo'));
    if (!isFinite(cil) || cil === 0) return;
    var desetin = parseInt(el.getAttribute('data-desetin'), 10) || 0;
    var pripona = el.getAttribute('data-pripona') || '';
    var hotovo = el.textContent;
    var delka = 900;
    var start = null;
    function krok(cas) {
      if (start === null) start = cas;
      var t = Math.min(1, (cas - start) / delka);
      var e = 1 - Math.pow(1 - t, 4); // easeOutQuart: rychle nahoru, zvolna dosedne
      if (t < 1) {
        el.textContent = format(cil * e, desetin, pripona);
        window.requestAnimationFrame(krok);
      } else {
        el.textContent = hotovo; // přesně text ze serveru, žádná zaokrouhlovací odchylka
      }
    }
    window.requestAnimationFrame(krok);
  }

  if (!klid) {
    var cisla = document.querySelectorAll('[data-pocitadlo]');
    if ('IntersectionObserver' in window) {
      var pozorovatel = new IntersectionObserver(function (zaznamy) {
        zaznamy.forEach(function (z) {
          if (!z.isIntersecting) return;
          pozorovatel.unobserve(z.target);
          dopocitej(z.target);
        });
      }, { threshold: 0.2 });
      cisla.forEach(function (el) { pozorovatel.observe(el); });
    } else {
      cisla.forEach(dopocitej);
    }
  }

  // ── Pruh načítání ─────────────────────────────────────────
  var pruh = document.createElement('div');
  pruh.className = 'nacitani-pruh';
  pruh.setAttribute('aria-hidden', 'true');
  document.body.appendChild(pruh);

  var pojistka = null;
  function nacita() {
    html.classList.add('nacitani');
    window.clearTimeout(pojistka);
    // Kdyby navigace neproběhla (stažení souboru, zrušení), pruh nesmí zůstat viset.
    pojistka = window.setTimeout(hotovo, 15000);
  }
  function hotovo() { html.classList.remove('nacitani'); }

  // Odkaz v rámci aplikace otevřený v tomtéž panelu.
  function vedeNaStranku(a) {
    if (!a || a.target && a.target !== '_self') return false;
    if (a.hasAttribute('download')) return false;
    var url;
    try { url = new URL(a.href, location.href); } catch (e) { return false; }
    if (url.origin !== location.origin) return false;
    if (url.pathname === location.pathname && url.search === location.search) return false; // jen kotva
    return !/\.[a-z0-9]{2,4}$/i.test(url.pathname); // CSV, PDF a jiné soubory se stahují
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('a[href]');
    if (a) {
      if (vedeNaStranku(a)) nacita();
      // Zvolená dlaždice se přepne hned, ne až s novou stránkou.
      var dlazdice = a.closest('.eshop-dlazdice-polozka');
      if (dlazdice && vedeNaStranku(a)) {
        dlazdice.parentNode.querySelectorAll('[aria-current]').forEach(function (x) {
          x.setAttribute('data-byla-zvolena', '');
          x.removeAttribute('aria-current');
        });
        dlazdice.setAttribute('aria-current', 'page');
      }
      return;
    }
    // Řádek tabulky jako odkaz (data-href, public/js/app.js).
    if (e.target.closest && e.target.closest('[data-href]') && !e.target.closest('button, input, select, textarea, label, summary, [data-bez-prokliku]')) {
      if (!(window.getSelection && window.getSelection().toString())) nacita();
    }
  });

  document.addEventListener('submit', function (e) {
    if (!e.defaultPrevented) nacita();
  });
  // Výběr období odesílá formulář přes form.submit(), ten událost submit nevyvolá.
  document.addEventListener('change', function (e) {
    if (e.target.id === 'prehledObdobi' && e.target.value !== 'vlastni') nacita();
  });

  // Návrat tlačítkem Zpět z mezipaměti prohlížeče: stránka se neprobouzí od
  // nuly, takže pruh zmizí a zvolená zůstane dlaždice téhle stránky.
  window.addEventListener('pageshow', function (e) {
    hotovo();
    if (!e.persisted) return;
    document.querySelectorAll('.eshop-dlazdice-polozka[data-byla-zvolena]').forEach(function (puvodni) {
      puvodni.parentNode.querySelectorAll('[aria-current]').forEach(function (x) { x.removeAttribute('aria-current'); });
      puvodni.removeAttribute('data-byla-zvolena');
      puvodni.setAttribute('aria-current', 'page');
    });
  });
})();
