-- Lokale Entwicklung: getrennte Datenbanken je Zweck.
-- mietroyal_dev  – lokale Entwicklung (POSTGRES_DB, wird vom Image angelegt)
-- mietroyal_test – Integrationstests (wird vor jedem Testlauf migriert)
-- mietroyal_demo – lokale Demo-Umgebung (strukturell getrennt von dev)
-- mietroyal_test7 – zweite Integrationstest-Datenbank (TEST_DATABASE_URL_SECOND:
--                   Cross-Environment-Tests Demo/Live, Phase 18)
CREATE DATABASE mietroyal_test OWNER mietroyal;
CREATE DATABASE mietroyal_demo OWNER mietroyal;
CREATE DATABASE mietroyal_test7 OWNER mietroyal;
