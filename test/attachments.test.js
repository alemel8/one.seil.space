// Zmenšování a ukládání příloh dokladů.
//
// Nepotřebuje běžící server ani databázi:
//   node --test test/attachments.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  compressImage, saveAttachment, deleteAttachment,
  MAX_ATTACHMENT_BYTES, MAX_UPLOAD_BYTES, isSupportedMime, mimeForFile, extForMime,
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
