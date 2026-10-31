/* ============================================================
   ONE.SEIL.SPACE — Main app JS
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {

  // ── Theme toggle ─────────────────────────────────────────
  const html = document.documentElement;
  const savedTheme = localStorage.getItem('seil-theme') || 'light';
  applyTheme(savedTheme);

  document.querySelectorAll('[data-set-theme]').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.getAttribute('data-set-theme');
      applyTheme(theme);
      localStorage.setItem('seil-theme', theme);
    });
  });

  // Aktivní tlačítko přepínače stylují selektory podle data-theme
  // (layout.css), takže stačí nastavit atribut.
  function applyTheme(theme) {
    html.setAttribute('data-theme', theme);
  }

  // ── Sidebar — sbalený pruh na desktopu ────────────────────
  // Stav drží <html data-sidebar="collapsed"> (nastavuje ho inline skript
  // v base.ejs ještě před vykreslením) a localStorage 'seil-sidebar'.
  // Hranice 768 px je stejná jako mobilní blok v layout.css.
  const mqMobil = window.matchMedia('(max-width: 768px)');
  const jeSbaleno = () => html.getAttribute('data-sidebar') === 'collapsed';

  // ── Sidebar nav — accordion ───────────────────────────────
  document.querySelectorAll('.nav-link[data-toggle="sub"]').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const item = link.closest('.nav-item');
      // Sbalený pruh: skupina je jedna ikona a vede na svou první
      // podstránku (jako v GrapeNetu) — rozbalovat není kam.
      if (!mqMobil.matches && jeSbaleno()) {
        const prvni = item.querySelector('.nav-sub-link');
        if (prvni) window.location.href = prvni.getAttribute('href');
        return;
      }
      const isOpen = item.classList.contains('open');
      item.closest('.sidebar-nav')
          ?.querySelectorAll('.nav-item.open')
          .forEach(el => {
            if (el === item) return;
            el.classList.remove('open');
            el.querySelector('.nav-link[data-toggle="sub"]')?.setAttribute('aria-expanded', 'false');
          });
      item.classList.toggle('open', !isOpen);
      link.setAttribute('aria-expanded', String(!isOpen));
    });
  });

  // Auto-open active section
  document.querySelectorAll('.nav-sub-link.active').forEach(link => {
    link.closest('.nav-item')?.classList.add('open');
  });
  document.querySelectorAll('.nav-link[data-toggle="sub"]').forEach(link => {
    link.setAttribute('aria-expanded', String(link.closest('.nav-item')?.classList.contains('open') ?? false));
  });

  // ── Záložky detailu — aktivní do zorného pole ─────────────
  // Šest záložek detailu e-shopu je přes 600 px; na telefonu by aktivní
  // zůstala za okrajem a uživatel by nevěděl, kde je.
  document.querySelector('.tabs .tab.active')?.scrollIntoView({ inline: 'center', block: 'nearest' });

  // ── User dropdown ─────────────────────────────────────────
  const userDropdown = document.getElementById('userDropdown');
  const userDropdownMenu = document.getElementById('userDropdownMenu');

  if (userDropdown && userDropdownMenu) {
    userDropdown.addEventListener('click', e => {
      e.stopPropagation();
      userDropdownMenu.classList.toggle('open');
    });
    document.addEventListener('click', () => {
      userDropdownMenu?.classList.remove('open');
    });
  }

  // ── Modals ────────────────────────────────────────────────
  document.querySelectorAll('[data-modal-open]').forEach(btn => {
    btn.addEventListener('click', () => openModal(btn.getAttribute('data-modal-open')));
  });

  document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) closeModal(backdrop.id);
    });
  });

  document.querySelectorAll('[data-modal-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.getAttribute('data-modal-close')));
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const open = document.querySelector('.modal-backdrop.open');
      if (open) closeModal(open.id);
    }
  });

  function openModal(id) {
    const el = document.getElementById(id);
    if (el) { el.classList.add('open'); document.body.style.overflow = 'hidden'; }
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('open'); document.body.style.overflow = ''; }
  }

  // ── Sidebar — přepínač (desktop sbalí pruh, mobil otevře drawer) ──
  const sidebarToggle = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('sidebar');
  const sidebarOverlay = document.getElementById('sidebarOverlay');

  function openSidebar() {
    sidebar?.classList.add('open');
    sidebarOverlay?.classList.add('visible');
    document.body.style.overflow = 'hidden';
    synchronizujTlacitko();
  }

  function closeSidebar() {
    sidebar?.classList.remove('open');
    sidebarOverlay?.classList.remove('visible');
    document.body.style.overflow = '';
    synchronizujTlacitko();
  }

  // Popisek a stav tlačítka podle toho, co právě ovládá: na mobilu drawer,
  // na desktopu sbalení pruhu. Natvrdo v šabloně by před spuštěním skriptu
  // lhal (menu je na desktopu rozbalené).
  function synchronizujTlacitko() {
    if (!sidebarToggle) return;
    if (mqMobil.matches) {
      const otevreno = sidebar?.classList.contains('open') ?? false;
      sidebarToggle.setAttribute('aria-label', otevreno ? 'Zavřít menu' : 'Otevřít menu');
      sidebarToggle.setAttribute('aria-expanded', String(otevreno));
    } else {
      sidebarToggle.setAttribute('aria-label', jeSbaleno() ? 'Rozbalit menu' : 'Sbalit menu');
      sidebarToggle.setAttribute('aria-expanded', String(!jeSbaleno()));
    }
  }

  // Tooltipy jen ve sbaleném stavu — v rozbaleném menu by překážely.
  // Zároveň dají odkazu přístupný název, když je jeho popisek skrytý.
  function nastavSidebar(sbalit) {
    if (sbalit) html.setAttribute('data-sidebar', 'collapsed');
    else html.removeAttribute('data-sidebar');
    sidebar?.querySelectorAll('.nav-link').forEach(a => {
      const text = a.querySelector('.nav-label')?.textContent.trim();
      if (sbalit && text) a.setAttribute('title', text); else a.removeAttribute('title');
    });
    const user = sidebar?.querySelector('.sidebar-user');
    if (user) {
      const jmeno = user.querySelector('.sidebar-user-name')?.textContent.trim();
      const role  = user.querySelector('.sidebar-user-role')?.textContent.trim();
      if (sbalit && jmeno) user.setAttribute('title', role ? `${jmeno} · ${role}` : jmeno);
      else user.removeAttribute('title');
    }
    synchronizujTlacitko();
  }

  sidebarToggle?.addEventListener('click', () => {
    if (mqMobil.matches) {
      sidebar?.classList.contains('open') ? closeSidebar() : openSidebar();
      return;
    }
    const sbalit = !jeSbaleno();
    nastavSidebar(sbalit);
    try { localStorage.setItem('seil-sidebar', sbalit ? 'collapsed' : 'expanded'); } catch {}
  });
  sidebarOverlay?.addEventListener('click', closeSidebar);
  // Přechod přes hranici: zavřít drawer i overlay (jinak by po zvětšení
  // okna zůstal overlay přes obsah) a srovnat popisek tlačítka.
  mqMobil.addEventListener('change', closeSidebar);
  nastavSidebar(jeSbaleno());

  sidebar?.querySelectorAll('.nav-sub-link').forEach(link => {
    link.addEventListener('click', () => {
      if (mqMobil.matches) closeSidebar();
    });
  });

});
