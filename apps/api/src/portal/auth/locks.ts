import type { DatabaseExecutor } from '@mietroyal/database';
import { sql } from 'drizzle-orm';

/**
 * Phase 15 (Review R6): Transaktions-Lock je Kunde für ALLE Portal-Auth-Schreibpfade
 * (Link-Anforderungen, Login-/E-Mail-Wechsel-Consume) und die Papierkorb-Löschung.
 * Feste Sperrreihenfolge: ZUERST dieser Kunden-Lock, danach erst Adress-Lock,
 * Link-/Session-Zeilen und die `customers`-Zeile – so können sich parallele
 * Consumes desselben Kunden nicht mehr gegenseitig blockieren (Deadlock 40P01).
 * Muss innerhalb einer Transaktion aufgerufen werden (`pg_advisory_xact_lock`).
 */
export async function lockPortalCustomerAuth(
  executor: DatabaseExecutor,
  customerId: string,
): Promise<void> {
  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${'portal-customer-auth:' + customerId}))`,
  );
}
