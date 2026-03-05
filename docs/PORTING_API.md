# Porting API (`POST /api/phone/porting/start`)

## Auth
- Requires barber JWT (`Authorization: Bearer <token>`).

## Idempotency
- Accepted in either location:
1. Header: `Idempotency-Key` (case-insensitive, so `idempotency-key` also works)
2. Body: `idempotencyKey`
- If both are sent, header value is used.
- Key scope is per barber for `phone.porting.start`.

## Accepted Request Schema

### Canonical fields
- `phoneNumber` (required)
  - Production: E.164 format (`+14155550123`)
  - Non-production: basic phone formatting accepted
- `businessName` (required)
- `authorizedName` (required)
- `authorizedRepresentativeEmail` (required, basic email format)
- `serviceAddress` (required object)
  - `line1` (required in production)
  - `city` (required in production)
  - `state` (required in production)
  - `postalCode` (required, production format: `12345` or `12345-6789`)
  - `country` (required, defaults to `US`)
- `carrierName` (required in production; free-text, not enum-restricted)
- `accountNumber` (required in production)
- `pin` (optional)
- `accountTelephoneNumber` (optional, defaults to `phoneNumber`)
- `customerType` (optional, defaults to `Business`)
- `requestedFocDate` (optional)

### Mobile aliases supported
- `carrier` -> `carrierName`
- `contactName` -> `businessName` and `authorizedName`
- `contactEmail` -> `authorizedRepresentativeEmail`
- `billingZip` -> `serviceAddress.postalCode`
- `idempotencyKey` -> idempotency key (if header not provided)

## Non-production (DEV) bypass
- Active when `NODE_ENV !== "production"`.
- Dummy values are allowed as long as:
  - `phoneNumber` has basic phone formatting
  - `authorizedRepresentativeEmail` is valid format
  - zip/postal code is non-empty
- Real carrier/account/pin strictness is not enforced in non-production.

## Example Request (known-good for dev)
```json
{
  "phoneNumber": "+15555551234",
  "carrier": "Test Carrier",
  "accountNumber": "DEV-ACC-001",
  "pin": "1234",
  "billingZip": "10001",
  "contactName": "Test Barber",
  "contactEmail": "test.barber@example.com",
  "idempotencyKey": "port-start-dev-001"
}
```

## Example 400 Validation Response
```json
{
  "code": "PORTING_VALIDATION_FAILED",
  "message": "Porting validation failed",
  "errors": [
    { "field": "phoneNumber", "message": "phoneNumber must be E.164 format (example: +14155550123)" },
    { "field": "authorizedRepresentativeEmail", "message": "authorizedRepresentativeEmail must be a valid email" },
    { "field": "serviceAddress.postalCode", "message": "Postal code must be 5 digits or ZIP+4" }
  ]
}
```
