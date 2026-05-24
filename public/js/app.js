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

  function applyTheme(theme) {
    html.setAttribute('data-theme', theme);
    document.querySelectorAll('[data-set-theme]').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-set-theme') === theme);
    });
  }

  // ── Sidebar nav — accordion ───────────────────────────────
  document.querySelectorAll('.nav-link[data-toggle="sub"]').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const item = link.closest('.nav-item');
      const isOpen = item.classList.contains('open');
      item.closest('.sidebar-nav')
          ?.querySelectorAll('.nav-item.open')
          .forEach(el => el !== item && el.classList.remove('open'));
      item.classList.toggle('open', !isOpen);
    });
  });

  // Auto-open active section
  document.querySelectorAll('.nav-sub-link.active').forEach(link => {
    link.closest('.nav-item')?.classList.add('open');
  });

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

  // ── Mobile sidebar toggle ─────────────────────────────────
  const sidebarToggle = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('sidebar');
  const sidebarOverlay = document.getElementById('sidebarOverlay');

  function openSidebar() {
    sidebar?.classList.add('open');
    sidebarOverlay?.classList.add('visible');
    document.body.style.overflow = 'hidden';
  }

  function closeSidebar() {
    sidebar?.classList.remove('open');
    sidebarOverlay?.classList.remove('visible');
    document.body.style.overflow = '';
  }

  sidebarToggle?.addEventListener('click', openSidebar);
  sidebarOverlay?.addEventListener('click', closeSidebar);

  sidebar?.querySelectorAll('.nav-sub-link').forEach(link => {
    link.addEventListener('click', () => {
      if (window.innerWidth <= 768) closeSidebar();
    });
  });

});
