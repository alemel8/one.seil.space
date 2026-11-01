// Návratová adresa z formuláře nebo odkazu. Přichází od prohlížeče, takže smí vést
// jen na cestu v aplikaci: //cizi.web a /\cizi.web prohlížeč chápe jako jiný web.

/** Hodnota, když je to cesta v aplikaci, jinak výchozí adresa. Hlavička Location nesmí obsahovat znaky mimo ASCII ani mezery. */
export function bezpecnyNavrat(hodnota, vychozi) {
  const v = Array.isArray(hodnota) ? hodnota[0] : hodnota;
  if (typeof v !== 'string') return vychozi;
  if (!/^\/(?![/\\])/.test(v) || /[\\\x00-\x1f\x7f]/.test(v)) return vychozi;
  try {
    return v.replace(/[^\x21-\x7e]+/g, encodeURIComponent);
  } catch {
    return vychozi;
  }
}
