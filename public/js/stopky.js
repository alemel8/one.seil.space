// Tikající počítadlo běžících stopek.
//
// Server vyrenderuje čas spuštění do data-start, prohlížeč jen dopočítává
// rozdíl. Nedrží žádný stav — zavření okna, restart ani přepnutí zařízení
// nic neztratí, protože pravda je řádek v databázi.

(function () {
  var prvky = document.querySelectorAll('.stopky-cas[data-start]');
  if (!prvky.length) return;

  function dvojciferne(n) { return n < 10 ? '0' + n : String(n); }

  function tik() {
    var ted = Date.now();
    for (var i = 0; i < prvky.length; i++) {
      var start = Date.parse(prvky[i].getAttribute('data-start'));
      if (isNaN(start)) continue;
      var s = Math.max(0, Math.floor((ted - start) / 1000));
      prvky[i].textContent = dvojciferne(Math.floor(s / 3600)) + ':'
        + dvojciferne(Math.floor((s % 3600) / 60)) + ':' + dvojciferne(s % 60);
    }
  }

  tik();
  setInterval(tik, 1000);
})();
