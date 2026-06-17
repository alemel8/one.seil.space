// Packeta (Zásilkovna) SOAP API klient — stažení PDF štítku přímo ze serveru,
// bez spoléhání na externě vygenerovaný (a časem expirující) odkaz.
// WSDL: http://www.zasilkovna.cz/api/soap-php-bugfix.wsdl, endpoint http://www.zasilkovna.cz/api/soap

const SOAP_ENDPOINT = 'http://www.zasilkovna.cz/api/soap';

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

export async function fetchPacketLabelPdf(packetId, format = 'A6 on A6') {
  const apiPassword = process.env.PACKETA_API_PASSWORD;
  if (!apiPassword) throw new Error('PACKETA_API_PASSWORD není nastaveno v prostředí');

  const cleanId = String(packetId).replace(/\D/g, '');
  if (!cleanId) throw new Error('Neplatné číslo zásilky');

  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://www.zasilkovna.cz/api/soap.wsdl2">
  <soapenv:Body>
    <tns:packetLabelPdf>
      <apiPassword>${escapeXml(apiPassword)}</apiPassword>
      <packetId>${escapeXml(cleanId)}</packetId>
      <format>${escapeXml(format)}</format>
      <offset>0</offset>
    </tns:packetLabelPdf>
  </soapenv:Body>
</soapenv:Envelope>`;

  const res = await fetch(SOAP_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': 'http://www.zasilkovna.cz/api/soap/packetLabelPdf',
    },
    body: envelope,
  });
  const xml = await res.text();

  const fault = xml.match(/<faultstring>([\s\S]*?)<\/faultstring>/);
  if (fault) throw new Error(`Packeta API: ${fault[1]}`);

  const result = xml.match(/<packetLabelPdfResult>([\s\S]*?)<\/packetLabelPdfResult>/);
  if (!result) throw new Error('Packeta API: štítek se nepodařilo načíst (neočekávaná odpověď)');

  return Buffer.from(result[1], 'base64');
}
