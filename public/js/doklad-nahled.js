/* ============================================================
   ONE.SEIL.SPACE — náhled dokladu v popup okně

   Doklad se dosud otevíral v novém panelu prohlížeče, čímž člověk ztratil
   kontext seznamu. Tohle ho ukáže rovnou nad stránkou, se stažením po ruce.

   Použití deklarativně — stačí atributy, obsluha je delegovaná, takže
   funguje i na řádcích vykreslených dodatečně:

     <a href="/doklady/soubor/x.jpg"
        data-nahled data-nahled-nazev="x.jpg" data-nahled-typ="image/jpeg"
        data-nahled-velikost="384000">…</a>

   Nebo z kódu:  dokladNahled.open({ url, name, mime, size })
   ============================================================ */

(function () {
  var el = null;      // kořen popupu, staví se až při prvním otevření
  var parts = {};
  var state = { url: '', name: '', zoom: false };

  function build() {
    el = document.createElement('div');
    el.className = 'dn-backdrop';
    el.innerHTML =
      '<div class="dn-modal" role="dialog" aria-modal="true" aria-label="Náhled dokladu">' +
        '<div class="dn-header">' +
          '<div class="dn-title">' +
            '<span class="dn-name"></span>' +
            '<span class="dn-meta"></span>' +
          '</div>' +
          '<button type="button" class="dn-close" title="Zavřít (Esc)" aria-label="Zavřít">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="dn-body">' +
          '<img class="dn-img" alt="Náhled dokladu" style="display:none">' +
          '<iframe class="dn-frame" title="Náhled dokumentu" style="display:none"></iframe>' +
          '<div class="dn-fallback" style="display:none">' +
            '<p>Tenhle typ souboru prohlížeč neumí zobrazit.</p>' +
          '</div>' +
        '</div>' +
        '<div class="dn-footer">' +
          '<span class="dn-hint"></span>' +
          '<span class="dn-actions">' +
            '<a class="btn btn-outline btn-sm dn-tab" target="_blank" rel="noopener">Otevřít v novém panelu</a>' +
            '<a class="btn btn-primary btn-sm dn-download">' +
              '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-2px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
              'Stáhnout' +
            '</a>' +
          '</span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);

    parts = {
      modal:    el.querySelector('.dn-modal'),
      name:     el.querySelector('.dn-name'),
      meta:     el.querySelector('.dn-meta'),
      img:      el.querySelector('.dn-img'),
      frame:    el.querySelector('.dn-frame'),
      fallback: el.querySelector('.dn-fallback'),
      hint:     el.querySelector('.dn-hint'),
      tab:      el.querySelector('.dn-tab'),
      download: el.querySelector('.dn-download'),
    };

    el.addEventListener('click', function (e) { if (e.target === el) close(); });
    el.querySelector('.dn-close').addEventListener('click', close);
    parts.img.addEventListener('click', toggleZoom);

    // Ve fázi capture, aby se Escape nedostal k obsluze modalů v app.js —
    // jinak by zavřel i rozepsaný formulář účtenky pod náhledem.
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !el.classList.contains('open')) return;
      e.stopPropagation();
      e.preventDefault();
      close();
    }, true);
  }

  function formatBytes(bytes) {
    var n = Number(bytes) || 0;
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' kB';
    return (n / (1024 * 1024)).toFixed(1).replace('.', ',') + ' MB';
  }

  function toggleZoom() {
    state.zoom = !state.zoom;
    parts.img.classList.toggle('dn-zoomed', state.zoom);
    parts.hint.textContent = state.zoom ? 'Klikni pro zmenšení' : 'Klikni do obrázku pro přiblížení';
  }

  function open(opts) {
    if (!el) build();
    var url  = opts.url;
    var mime = opts.mime || '';
    var name = opts.name || url.split('/').pop().split('?')[0];

    state.url = url;
    state.name = name;
    state.zoom = false;

    parts.name.textContent = name;
    parts.meta.textContent = formatBytes(opts.size);
    parts.img.classList.remove('dn-zoomed');
    parts.img.style.display = parts.frame.style.display = parts.fallback.style.display = 'none';
    parts.img.src = ''; parts.frame.src = 'about:blank';

    // Typ neznáme jen u blob: URL z právě vybraného souboru — dopadneme na příponu
    var isImage = mime.indexOf('image/') === 0 || (!mime && /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(name));
    var isPdf   = mime === 'application/pdf' || (!mime && /\.pdf$/i.test(name));

    if (isImage) {
      parts.img.style.display = '';
      parts.img.src = url;
      parts.hint.textContent = 'Klikni do obrázku pro přiblížení';
    } else if (isPdf) {
      parts.frame.style.display = '';
      parts.frame.src = url;
      parts.hint.textContent = '';
    } else {
      parts.fallback.style.display = '';
      parts.hint.textContent = '';
    }

    parts.tab.href = url;
    // Chráněná routa umí vynutit stažení; u blob: URL stačí atribut download
    parts.download.href = url.indexOf('blob:') === 0
      ? url
      : url + (url.indexOf('?') === -1 ? '?' : '&') + 'download=1';
    parts.download.setAttribute('download', name);

    el.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    if (!el) return;
    el.classList.remove('open');
    parts.frame.src = 'about:blank';   // ať PDF v pozadí needitujeme dál
    parts.img.src = '';
    // Popup může běžet nad jiným modalem — scroll vracíme jen když už žádný není
    if (!document.querySelector('.modal-backdrop.open')) document.body.style.overflow = '';
  }

  // Delegovaná obsluha — funguje i na dodatečně vykreslených prvcích
  document.addEventListener('click', function (e) {
    var trigger = e.target.closest('[data-nahled]');
    if (!trigger) return;
    var url = trigger.getAttribute('data-nahled-url') || trigger.getAttribute('href');
    if (!url) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;   // ať jde otevřít i do panelu
    e.preventDefault();
    open({
      url: url,
      name: trigger.getAttribute('data-nahled-nazev') || '',
      mime: trigger.getAttribute('data-nahled-typ') || '',
      size: trigger.getAttribute('data-nahled-velikost') || 0,
    });
  });

  window.dokladNahled = { open: open, close: close };
})();
