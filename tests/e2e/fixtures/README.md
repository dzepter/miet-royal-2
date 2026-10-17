# E2E-Fixtures (Phase 10 – Lexware-Contract-Fake)

`lexware-fake-private-key.pem` / `lexware-fake-public-key.pem` sind ein
**reines Test-Schlüsselpaar für den lokalen Lexware-Fake**
(`apps/api/src/lexware/testing/fake-server.ts`). Es ist **kein Secret**:

- Der Fake signiert damit Webhook-Bodies (`X-Lxo-Signature`, RSA-SHA512),
  die API-Instanz des Playwright-Projekts `lexware` prüft sie gegen den
  Public Key (`LEXWARE_WEBHOOK_PUBLIC_KEY_PEM`, siehe `playwright.config.ts`).
- Es hat nichts mit dem offiziellen Lexware-Public-Key zu tun und wird
  niemals in einer echten Umgebung verwendet.

Erzeugt mit:

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out lexware-fake-private-key.pem   # PKCS#8
openssl pkey -in lexware-fake-private-key.pem -pubout -out lexware-fake-public-key.pem            # SPKI
```

Bei Neuerzeugung beide Dateien gemeinsam ersetzen – die Config liest den
Public Key beim Start aus der Datei, der Fake den Private Key über
`LEXWARE_FAKE_PRIVATE_KEY_FILE`.
