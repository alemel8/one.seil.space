// Graf marketingového přehledu: tržby bez DPH (sloupce), náklady na reklamu
// (čára) a PNO dne (čára na pravé ose). Data nese <script type="application/json"
// id="marketing-data"> ze src/marketing/kpi.js radyProGraf(); Chart.js je
// vendorovaný v /static/chart.umd.min.js. Barvy jen jako hex — canvas
// CSS proměnné nezná.
(function () {
  var el = document.getElementById('marketing-data');
  var canvas = document.getElementById('marketing-graf');
  if (!el || !canvas || typeof Chart === 'undefined') return;
  var data;
  try { data = JSON.parse(el.textContent); } catch (e) { return; }
  if (!data || !data.dny || !data.dny.length) return;

  var kc = function (v) { return v == null ? '—' : Number(v).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' Kč'; };
  var pct = function (v) { return v == null ? '—' : Number(v).toLocaleString('cs-CZ', { maximumFractionDigits: 1 }) + ' %'; };

  new Chart(canvas, {
    data: {
      labels: data.popisky,
      datasets: [
        { type: 'bar', label: 'Tržby bez DPH', data: data.trzby, backgroundColor: 'rgba(20,230,230,0.45)', borderColor: '#14E6E6', borderWidth: 1, yAxisID: 'y', order: 2 },
        { type: 'line', label: 'Náklady na reklamu', data: data.naklady, borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.12)', tension: 0.3, pointRadius: 2, fill: true, yAxisID: 'y', order: 1 },
        { type: 'line', label: 'PNO', data: data.pno, borderColor: '#ef4444', borderDash: [4, 4], spanGaps: true, tension: 0.3, pointRadius: 2, yAxisID: 'y2', order: 0 },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top' },
        tooltip: { callbacks: { label: function (ctx) { return ctx.dataset.label + ': ' + (ctx.dataset.yAxisID === 'y2' ? pct(ctx.parsed.y) : kc(ctx.parsed.y)); } } },
      },
      scales: {
        y: { beginAtZero: true, title: { display: true, text: 'Kč bez DPH' } },
        y2: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'PNO %' } },
      },
    },
  });
})();
