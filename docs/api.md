# API dokumentace

Interaktivní Swagger UI je dostupné na `/api/docs` (vyžaduje přihlášení).

---

## Autentizace API

### X-API-Key (multi-shop API)
```
X-API-Key: <64 hex znaků>
```
Klíče se spravují v `/nastaveni/eshopy`.

### Bearer token (Toneráček webhook)
```
Authorization: Bearer <TONERACEK_API_KEY>
```
Hodnota z env proměnné `TONERACEK_API_KEY`.

---

## Multi-shop API (`/api/v1`)

### POST /api/v1/orders
Příjem nové objednávky.

**Headers:** `X-API-Key: <key>`, `Content-Type: application/json`

**Body:**
```json
{
  "orderNumber": "12345",
  "paymentMethod": "card",
  "currency": "CZK",
  "totalPrice": 1490.00,
  "ipAddress": "1.2.3.4",
  "notes": "Poznámka k objednávce",
  "isRegistered": false,
  "customer": {
    "firstName": "Jan",
    "lastName": "Novák",
    "email": "jan@example.com",
    "phone": "+420123456789",
    "company": "",
    "ic": "",
    "dic": "",
    "address": "Hlavní 1",
    "city": "Praha",
    "zip": "11000",
    "country": "Česká republika"
  },
  "shipping": {
    "method": "Zásilkovna",
    "firstName": "Jan",
    "lastName": "Novák",
    "address": "Hlavní 1",
    "city": "Praha",
    "zip": "11000",
    "pickupPointId": "12345",
    "pickupPointName": "Zásilkovna Praha 1"
  },
  "items": [
    {
      "sku": "TN-001",
      "name": "Toner HP 12A",
      "quantity": 2,
      "price": 745.00,
      "productId": "prod-001"
    }
  ]
}
```

**Response 201:**
```json
{
  "orderId": "lx7k9abc123",
  "orderNumber": "12345",
  "sourceShop": "muj-eshop",
  "invoiceNumber": "ESHOP-2026-12345"
}
```

---

### GET /api/v1/orders
Seznam objednávek e-shopu.

**Query params:**
- `email` — filtr dle e-mailu zákazníka
- `limit` — počet výsledků (výchozí 50)

**Response 200:**
```json
[
  {
    "id": "lx7k9abc123",
    "order_number": "12345",
    "status": "Přijata",
    "total_price": 1490,
    "email": "jan@example.com",
    "created_at": "2026-06-04T10:00:00Z"
  }
]
```

---

### GET /api/v1/customers
Zákazníci e-shopu registrovaní přes CRM.

---

## Toneráček API (`/api/toneracek`)

### POST /api/toneracek/orders
Struktura shodná s `/api/v1/orders` s drobnými odchylkami v názvech polí.

**Response 200:**
```json
{
  "orderId": "lx7k9abc123",
  "orderNumber": "10001",
  "invoiceNumber": "FV-2026-10001"
}
```

---

### PATCH /api/toneracek/orders/:id/tracking
Aktualizace čísla zásilky.

**Body:**
```json
{
  "trackingNumber": "Z123456789",
  "labelUrl": "https://toneracek.cz/labels/Z123456789.pdf"
}
```

---

## Push API (`/api/push`)

Vyžaduje přihlášeného uživatele (session).

### GET /api/push/vapid-key
Vrátí VAPID public key pro registraci v prohlížeči.

```json
{ "publicKey": "BLZkYZPp-Bic..." }
```

### POST /api/push/subscribe
Registrace subscription (data z `pushManager.subscribe()`).

```json
{
  "endpoint": "https://fcm.googleapis.com/fcm/send/...",
  "keys": {
    "p256dh": "BBHo...",
    "auth": "tB3..."
  }
}
```

### POST /api/push/unsubscribe
```json
{ "endpoint": "https://fcm.googleapis.com/..." }
```

### POST /api/push/status
Ověření, zda je toto zařízení registrováno.
```json
{ "endpoint": "https://..." }
```
Response: `{ "subscribed": true }`

---

## Interní API (pro UI)

| Route | Popis |
|---|---|
| `GET /api/banka/doklady` | Faktury a účtenky pro autocomplete párování |
| `GET /api/cashflow` | Data cash flow pro grafy |
| `GET /api/accounting-chart` | Účetní osnova pro autocomplete |
| `POST /api/invoice-series/:id/next` | Generování čísla faktury |
| `GET /api/healthchecks/status` | Poslední výsledky healthchecků |
| `GET /api/latest` | VPS stats snapshot (JSON) |
| `GET /api/history` | VPS stats 72h historie (JSON) |
