// Graf marketingového přehledu: tržby bez DPH (sloupce), náklady na reklamu
// (čára) a PNO dne (čára na pravé ose). Data nese <script type="application/json"
// id="marketing-data"> ze src/marketing/kpi.js radyProGraf(); u celkového
// přehledu (sestavCelkovyPrehled) navíc `eshopy` – tržby každého e-shopu, které
// jdou nad sebou v jeho barvě. Chart.js je vendorovaný v /static/chart.umd.min.js.
// Barvy jen jako hex – canvas CSS proměnné nezná.
(function () {
  var el = document.getElementById('marketing-data');
  var canvas = document.getElementById('marketing-graf');
  if (!el || !canvas || typeof Chart === 'undefined') return;
  var data;
  try { data = JSON.parse(el.textContent); } catch (e) { return; }
  if (!data || !data.dny || !data.dny.length) return;

  // Výchozí šedý text a černá mřížka Chart.js by v tmavém režimu skoro nebyly vidět.
  var tmave = document.documentElement.getAttribute('data-theme') === 'dark';
  Chart.defaults.color = tmave ? '#A9B3C0' : '#4B5563';
  Chart.defaults.borderColor = tmave ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  Chart.defaults.font.family = "'Space Grotesk', sans-serif";

  var klid = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var kc = function (v) { return v == null ? '–' : Number(v).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' Kč'; };
  var pct = function (v) { return v == null ? '–' : Number(v).toLocaleString('cs-CZ', { maximumFractionDigits: 1 }) + ' %'; };

  /** #rgb / #rrggbb → rgba() s průhledností; neplatná barva → SEIL Cyan. */
  function pruhledna(hex, alfa) {
    var h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex || '') ? hex.slice(1) : '14E6E6';
    if (h.length === 3) h = h.replace(/(.)/g, '$1$1');
    var n = parseInt(h, 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + alfa + ')';
  }

  // Tržby: u celkového přehledu jeden sloupec na e-shop (nad sebou), jinak jeden v barvě e-shopu.
  var celkovy = Boolean(data.eshopy && data.eshopy.length);
  var sloupce = (celkovy ? data.eshopy : [{ nazev: 'Tržby bez DPH', barva: data.barva, trzby: data.trzby }])
    .map(function (e) {
      return {
        type: 'bar', label: celkovy ? e.nazev : 'Tržby bez DPH', data: e.trzby,
        backgroundColor: pruhledna(e.barva, tmave ? 0.7 : 0.55), hoverBackgroundColor: pruhledna(e.barva, 0.9),
        // Nad sebou jen horní roh: zaoblené spoje mezi e-shopy by sloupec rozdělily na kostky.
        borderWidth: 0, borderRadius: celkovy ? 3 : 4, borderSkipped: 'start',
        stack: 'trzby', yAxisID: 'y', order: 2,
      };
    });

  // Plocha pod náklady: přechod od oranžové do průhledna podle výšky grafu.
  function vyplnNakladu(ctx) {
    var oblast = ctx.chart.chartArea;
    if (!oblast) return 'rgba(245,158,11,0.12)';
    var g = ctx.chart.ctx.createLinearGradient(0, oblast.top, 0, oblast.bottom);
    g.addColorStop(0, 'rgba(245,158,11,0.28)');
    g.addColorStop(1, 'rgba(245,158,11,0)');
    return g;
  }

  new Chart(canvas, {
    data: {
      labels: data.popisky,
      datasets: sloupce.concat([
        { type: 'line', label: 'Náklady na reklamu', data: data.naklady, borderColor: '#f59e0b', backgroundColor: vyplnNakladu, borderWidth: 2, tension: 0.35, pointRadius: 0, pointHoverRadius: 4, fill: true, yAxisID: 'y', order: 1 },
        { type: 'line', label: 'PNO', data: data.pno, borderColor: '#ef4444', borderWidth: 1.5, borderDash: [4, 4], spanGaps: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 4, yAxisID: 'y2', order: 0 },
      ]),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false, // výšku drží obal v šabloně, poměr stran by graf na telefonu zplacatil
      locale: 'cs-CZ',
      interaction: { mode: 'index', intersect: false },
      // Sloupce vyrostou postupně zleva, e-shopy nad sebou s malým zpožděním.
      animation: klid ? false : {
        duration: 700,
        easing: 'easeOutQuart',
        delay: function (ctx) {
          return ctx.type === 'data' && ctx.mode === 'default' ? ctx.dataIndex * 12 + ctx.datasetIndex * 80 : 0;
        },
      },
      plugins: {
        // Legenda v pořadí datových řad (e-shopy, náklady, PNO), ne podle vrstvy kreslení.
        legend: { position: 'top', labels: { usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 10, boxHeight: 10, sort: function (a, b) { return a.datasetIndex - b.datasetIndex; } } },
        tooltip: {
          padding: 10, cornerRadius: 8, boxPadding: 4, usePointStyle: true,
          callbacks: { label: function (ctx) { return ctx.dataset.label + ': ' + (ctx.dataset.yAxisID === 'y2' ? pct(ctx.parsed.y) : kc(ctx.parsed.y)); } },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Kč bez DPH' } },
        y2: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'PNO %' } },
      },
    },
  });
})();
