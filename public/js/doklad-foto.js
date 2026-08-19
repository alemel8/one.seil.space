/* ============================================================
   ONE.SEIL.SPACE — příprava fotky dokladu před nahráním

   Fotka z mobilu má 4–12 MB. Nahrávat ji v plné velikosti nemá smysl:
   zdržuje upload na datech, zbytečně zatěžuje vytěžování Claudem a v archivu
   zabírá místo. Účtenka je čitelná i po zmenšení na ~2400 px delší strany,
   takže ji před odesláním překreslíme přes canvas do JPEGu.

   PDF a už dost malé obrázky procházejí beze změny.
   ============================================================ */

(function () {
  var MAX_BYTES = 4.5 * 1024 * 1024;   // rezerva pod 5MB stropem na serveru
  var STEPS = [
    { edge: 2400, quality: 0.78 },
    { edge: 2000, quality: 0.70 },
    { edge: 1600, quality: 0.62 },
    { edge: 1400, quality: 0.50 }
  ];

  function decode(file) {
    // createImageBitmap srovná fotku podle EXIF orientace — bez toho leží
    // účtenky vyfocené na výšku na boku.
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () { return createImageBitmap(file); })
        .catch(function () { return decodeViaImg(file); });
    }
    return decodeViaImg(file);
  }

  function decodeViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('nelze dekódovat')); };
      img.src = url;
    });
  }

  function toBlob(canvas, quality) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) { resolve(blob); }, 'image/jpeg', quality);
    });
  }

  function jpegName(name) {
    return String(name || 'doklad').replace(/\.[^.]+$/, '') + '.jpg';
  }

  /**
   * Vrátí { file, originalBytes, finalBytes, changed, note }.
   * Když se cokoli nepovede (HEIC bez podpory v prohlížeči, chybějící canvas),
   * vrací původní soubor — uložení dokladu má přednost před zmenšením.
   */
  async function prepare(file) {
    var result = { file: file, originalBytes: file ? file.size : 0, finalBytes: file ? file.size : 0, changed: false, note: '' };
    if (!file || !file.type || file.type.indexOf('image/') !== 0) return result;

    try {
      var src = await decode(file);
      var sw = src.width, sh = src.height;
      if (!sw || !sh) return result;

      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d');
      var best = null;

      for (var i = 0; i < STEPS.length; i++) {
        var step = STEPS[i];
        var scale = Math.min(1, step.edge / Math.max(sw, sh));
        canvas.width  = Math.max(1, Math.round(sw * scale));
        canvas.height = Math.max(1, Math.round(sh * scale));
        ctx.fillStyle = '#fff';                       // JPEG neumí průhlednost
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(src, 0, 0, canvas.width, canvas.height);

        var blob = await toBlob(canvas, step.quality);
        if (!blob) break;
        best = blob;
        if (blob.size <= MAX_BYTES) break;
      }

      if (src.close) src.close();
      if (!best) return result;

      // U malých obrázků (screenshot, sken) může být převod větší než originál
      if (best.size >= file.size && file.size <= MAX_BYTES) return result;

      result.file = new File([best], jpegName(file.name), { type: 'image/jpeg', lastModified: Date.now() });
      result.finalBytes = best.size;
      result.changed = true;
      result.note = 'Foto zmenšeno z ' + formatBytes(result.originalBytes) + ' na ' + formatBytes(result.finalBytes);
      return result;
    } catch (err) {
      return result;
    }
  }

  function formatBytes(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' kB';
    return (n / (1024 * 1024)).toFixed(1).replace('.', ',') + ' MB';
  }

  window.dokladFoto = { prepare: prepare, formatBytes: formatBytes, MAX_BYTES: MAX_BYTES };
})();
