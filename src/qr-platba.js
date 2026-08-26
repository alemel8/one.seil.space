import QRCode from 'qrcode';

/**
 * QR platba (formát SPAYD) jako data: URI.
 *
 * Do PDF se vkládá přímo, ne odkazem: renderuje se přes puppeteer, takže
 * externí obrázek by znamenal síťový požadavek uprostřed vystavování dokladu
 * a další věc, která může spadnout, zatímco zákazník čeká v pokladně.
 * (V e-mailu je to naopak — tam data: URI nefunguje, Gmail je zahazuje,
 * proto qrPaymentImageUrl() v src/email.js míří na veřejný endpoint.)
 *
 * Vrací null, když chybí cokoli podstatného. Doklad bez QR kódu je pořád
 * platný doklad; QR kód mířící na neúplné zadání je horší než žádný.
 */
export async function qrPlatbaDataUri({ iban, amount, variableSymbol, message, currency = 'CZK' }) {
  if (!iban || !amount || !variableSymbol) return null;

  const spayd = [
    'SPD*1.0',
    `ACC:${String(iban).replace(/\s/g, '')}`,
    `AM:${Number(amount).toFixed(2)}`,
    `CC:${currency}`,
    `X-VS:${variableSymbol}`,
    ...(message ? [`MSG:${message}`] : []),
  ].join('*');

  try {
    return await QRCode.toDataURL(spayd, {
      width: 300, margin: 0,
      color: { dark: '#1a1a1a', light: '#ffffff' },
    });
  } catch {
    return null;
  }
}
