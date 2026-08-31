-- Lokale Entwicklung: getrennte Datenbanken je Zweck.
-- mietroyal_dev  – lokale Entwicklung (POSTGRES_DB, wird vom Image angelegt)
-- mietroyal_test – Integrationstests (wird vor jedem Testlauf migriert)
-- mietroyal_demo – lokale Demo-Umgebung (strukturell getrennt von dev)
CREATE DATABASE mietroyal_test OWNER mietroyal;
CREATE DATABASE mietroyal_demo OWNER mietroyal;
