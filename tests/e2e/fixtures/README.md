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

# E2E-Fixtures (Phase 12 – Kommunikations-Fakes)

`tls/ca.pem`, `tls/server.pem`, `tls/server-key.pem` sind **reines
Test-Material, nur für Tests, nie produktiv** – eine eigene Test-CA und ein
damit signiertes Serverzertifikat für `localhost` / `127.0.0.1` (SAN). Kein
Secret, kein Bezug zu echten Zertifikaten; der private Schlüssel der CA wurde
nach der Erzeugung verworfen.

- Die lokalen Fakes (`../fakes/communication-fakes.ts`: SMTP-Senke mit
  implizitem TLS, Web-Push-Dienst und WhatsApp-Mediendownload per HTTPS)
  präsentieren `server.pem`/`server-key.pem`.
- Die E2E-APIs vertrauen der Test-CA ausschließlich über
  `NODE_EXTRA_CA_CERTS=<tls/ca.pem>` im API-Prozess (`playwright.config.ts`).
  Die Zertifikatsprüfung bleibt damit eingeschaltet
  (`rejectUnauthorized: true` im `SmtpMailGateway`) – genau wie in production.
- Niemals in eine echte Umgebung, einen Trust-Store oder ein Image übernehmen.

Erzeugt mit (OpenSSL 3, Gültigkeit 10 Jahre):

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca-key.pem -out ca.pem -days 3650 -sha256 \
  -subj "/O=Miet-Royal E2E/CN=Miet-Royal E2E Test-CA (NUR TESTS)" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl req -newkey rsa:2048 -nodes -keyout server-key.pem -out server.csr -sha256 \
  -subj "/O=Miet-Royal E2E/CN=localhost"
printf "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n" > ext.cnf
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -set_serial 0x$(openssl rand -hex 8) \
  -out server.pem -days 3650 -sha256 -extfile ext.cnf
rm ca-key.pem server.csr ext.cnf
```

Die übrigen Test-Zugangsdaten der Fakes (SMTP-Benutzer/-Passwort,
WhatsApp-Token/App-Secret/Verify-Token, VAPID-Testschlüsselpaar) stehen als
synthetische Konstanten in `../fakes/constants.ts` – ebenfalls nur für Tests.
