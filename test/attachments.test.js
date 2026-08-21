// Zmenšování a ukládání příloh dokladů.
//
// Nepotřebuje běžící server ani databázi:
//   node --test test/attachments.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  compressImage, saveAttachment, deleteAttachment, MEDIA_DIR,
  MAX_ATTACHMENT_BYTES, MAX_UPLOAD_BYTES, isSupportedMime, isArchivableMime,
  mimeForFile, extForMime,
} from '../src/attachments.js';

// Fotka v rozlišení mobilu, plná šumu — nejhorší možný případ pro JPEG,
// reálná účtenka je po zmenšení výrazně menší.
async function fotoZMobilu({ orientation } = {}) {
  const W = 4032, H = 3024;
  const raw = Buffer.alloc(W * H * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) & 0xff;
  let img = sharp(raw, { raw: { width: W, height: H, channels: 3 } });
  if (orientation) img = img.withMetadata({ orientation });
  return img.jpeg({ quality: 100 }).toBuffer();
}

describe('přílohy dokladů', () => {
  test('fotka z mobilu se vejde pod 5 MB a zůstane čitelná', async () => {
    const original = await fotoZMobilu();
    assert.ok(original.length > MAX_ATTACHMENT_BYTES, 'testovací foto musí být nad stropem');

    const { buf, mime, compressed } = await compressImage(original, 'image/jpeg');
    assert.equal(compressed, true);
    assert.equal(mime, 'image/jpeg');
    assert.ok(buf.length <= MAX_ATTACHMENT_BYTES, `zmenšenina má ${buf.length} B`);

    // Delší strana ≥ 1400 px — pod tím už drobné písmo na účtence nepřečteme
    const meta = await sharp(buf).metadata();
    assert.ok(Math.max(meta.width, meta.height) >= 1400);
  });

  test('účtenka vyfocená na výšku se srovná podle EXIF', async () => {
    const { buf } = await compressImage(await fotoZMobilu({ orientation: 6 }), 'image/jpeg');
    const meta = await sharp(buf).metadata();
    assert.ok(meta.height > meta.width, 'po srovnání musí být na výšku');
  });

  test('malý sken v PNG se nepřekóduje', async () => {
    const png = await sharp({ create: { width: 800, height: 1200, channels: 3, background: '#fff' } })
      .png().toBuffer();
    const res = await compressImage(png, 'image/png');
    assert.equal(res.compressed, false);
    assert.equal(res.mime, 'image/png');
  });

  test('uložení vrátí metadata a soubor jde smazat', async () => {
    const saved = await saveAttachment(await fotoZMobilu(), 'image/jpeg', 'uctenka-test');
    try {
      assert.match(saved.filename, /^uctenka-test_\d+\.jpg$/);
      assert.equal(saved.mime, 'image/jpeg');
      assert.ok(saved.size <= MAX_ATTACHMENT_BYTES);
      assert.ok(saved.originalSize > saved.size);
    } finally {
      await deleteAttachment(saved.filename);
    }
  });

  test('vícestránkový sken v PDF nad 5 MB se uloží, jen se zaloguje', async () => {
    const warnings = [];
    const saved = await saveAttachment(
      Buffer.alloc(MAX_ATTACHMENT_BYTES + 1024, 1), 'application/pdf', 'faktura-test',
      { log: { warn: (...a) => warnings.push(a) } },
    );
    try {
      assert.match(saved.filename, /\.pdf$/);
      assert.equal(warnings.length, 1);
    } finally {
      await deleteAttachment(saved.filename);
    }
  });

  test('soubor nad stropem uploadu skončí srozumitelnou chybou', async () => {
    await assert.rejects(
      () => saveAttachment(Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1), 'application/pdf', 'faktura'),
      /maximum je/,
    );
  });

  test('nepodporované typy se odmítnou', async () => {
    await assert.rejects(() => saveAttachment(Buffer.from('x'), 'text/html', 'doklad'), /Podporujeme jen/);
    assert.equal(isSupportedMime('application/pdf'), true);
    assert.equal(isSupportedMime('image/heic'), true);
    assert.equal(isSupportedMime('application/zip'), false);
  });

  test('typ souboru se odvodí z přípony a naopak', () => {
    assert.equal(mimeForFile('uctenka_1.jpg'), 'image/jpeg');
    assert.equal(mimeForFile('inv_recv_2.pdf'), 'application/pdf');
    assert.equal(extForMime('image/png'), '.png');
    assert.equal(extForMime('application/pdf'), '.pdf');
  });

  test('archivní typy projdou jen v archivním režimu', async () => {
    // Formulář dokladu je má odmítnout — účetní tam patří sken, ne tabulka.
    assert.equal(isSupportedMime('text/xml'), false);
    assert.equal(isArchivableMime('text/xml'), true);
    assert.equal(isArchivableMime('application/zip'), true);
    // I HTML a SVG: příloha úkolu může být cokoli a zahodit ji potichu by
    // bylo horší. Že se nespustí, drží routa dokladů — inline pouští jen
    // PDF a rastrové obrázky, zbytek jde ke stažení s nosniff.
    assert.equal(isArchivableMime('text/html'), true);

    await assert.rejects(
      () => saveAttachment(Buffer.from('<?xml version="1.0"?><x/>'), 'text/xml', 'epodani'),
      /Podporujeme jen/,
    );

    const saved = await saveAttachment(
      Buffer.from('<?xml version="1.0"?><x/>'), 'text/xml', 'epodani', { archive: true },
    );
    try {
      assert.match(saved.filename, /^epodani_\d+\.xml$/);
      assert.equal(saved.mime, 'text/xml');
      assert.equal(mimeForFile(saved.filename), 'text/xml');
    } finally {
      await deleteAttachment(saved.filename);
    }
  });

  test('archivní soubor se neprožene kompresí', async () => {
    // Výplatní páska ani e-podání se nesmí přeukládat — je to důkazní materiál.
    const original = await fotoZMobilu();
    const saved = await saveAttachment(original, 'image/jpeg', 'pruvodka', { archive: true });
    try {
      assert.equal(saved.size, original.length, 'archivní soubor musí zůstat beze změny');
    } finally {
      await deleteAttachment(saved.filename);
    }
  });

  test('dva soubory ve stejné milisekundě si nepřepíšou obsah', async () => {
    // Hromadný import zapisuje stovky souborů v těsné smyčce. Dřív rozhodovalo
    // jen Date.now() a druhý zápis tiše přepsal první — bez jediné chyby.
    const dohromady = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        saveAttachment(Buffer.from(`doklad ${i}`), 'application/pdf', 'davka', { archive: true })),
    );
    try {
      const nazvy = new Set(dohromady.map(v => v.filename));
      assert.equal(nazvy.size, dohromady.length, 'každý soubor musí mít vlastní název');
      for (const [i, v] of dohromady.entries()) {
        const obsah = await readFile(path.join(MEDIA_DIR, v.filename), 'utf8');
        assert.equal(obsah, `doklad ${i}`, 'obsah se nesmí přepsat cizím souborem');
      }
    } finally {
      await Promise.all(dohromady.map(v => deleteAttachment(v.filename)));
    }
  });

  test('název souboru se očistí od cizích znaků', async () => {
    const saved = await saveAttachment(
      await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).jpeg().toBuffer(),
      'image/jpeg', '../../etc/pas wd',
    );
    try {
      assert.ok(!saved.filename.includes('/'));
      assert.ok(!saved.filename.includes(' '));
    } finally {
      await deleteAttachment(saved.filename);
    }
  });
});

describe('archivní režim', () => {
  test('vezme i typ, který formuláře nepustí', async () => {
    // Přílohy úkolů jsou libovolné soubory — v datech z Airtable je vedle
    // PDF a XML i skript v Pythonu. Allowlist by je tiše zahodil.
    for (const mime of ['text/x-python-script', 'application/zip',
                        'application/vnd.oasis.opendocument.text']) {
      assert.equal(isArchivableMime(mime), true, mime);
      assert.equal(isSupportedMime(mime), false, `${mime} nesmí projít do účtenek`);
    }
  });

  test('HTML a SVG se nikdy neotevřou v prohlížeči', async () => {
    const zdroj = await readFile(new URL('../src/routes/documents.js', import.meta.url), 'utf8');
    const seznam = zdroj.slice(zdroj.indexOf('const NAHLED_MIME'), zdroj.indexOf('*/', zdroj.indexOf('const NAHLED_MIME')));
    for (const mime of ['text/html', 'image/svg+xml', 'text/xml', 'application/zip']) {
      assert.ok(!seznam.includes(mime), `${mime} nesmí být mezi typy pro inline náhled`);
    }
  });

  test('prázdný typ neprojde ani archivně', () => {
    assert.equal(isArchivableMime(''), false);
    assert.equal(isArchivableMime(null), false);
  });
});
