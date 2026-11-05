import type { Database } from '@mietroyal/database';
import { CustomerService, type CustomerInput } from '../../crm/customer-service.ts';
import { buildPortalProfileView, type PortalProfileView } from './views.ts';

/** Vom Kunden änderbare Felder (Order §31/§33) – nie `type`, nie `email`. */
export type PortalProfilePatch = Omit<CustomerInput, 'type' | 'email'>;

/**
 * Phase 15 (Order §31–§33): Profil = aktuelle Stammdaten des Kunden. Lesen aus
 * `customers` (nur aktive Kunden), Schreiben über die CRM-Validierung
 * (`CustomerService.updateCustomerFromPortal`). Die Reauth-Frische prüft die
 * Route (403 `PORTAL_REAUTH_REQUIRED`); Buchungs-Snapshots bleiben unberührt.
 */
export class PortalProfileService {
  private readonly customersService: CustomerService;

  constructor(db: Database) {
    this.customersService = new CustomerService(db);
  }

  /** Wirft AuthError NOT_FOUND, wenn der Kunde gelöscht ist (Route ⇒ 401). */
  async view(customerId: string): Promise<PortalProfileView> {
    const customer = await this.customersService.getActiveCustomer(customerId);
    return buildPortalProfileView(customer);
  }

  async update(
    customerId: string,
    patch: PortalProfilePatch,
    now: Date = new Date(),
  ): Promise<PortalProfileView> {
    const customer = await this.customersService.updateCustomerFromPortal(customerId, patch, now);
    return buildPortalProfileView(customer);
  }

  /** Typ des Kunden (bestimmt das erlaubte Patch-Schema der Route). */
  async customerType(customerId: string): Promise<'private' | 'organization'> {
    const customer = await this.customersService.getActiveCustomer(customerId);
    return customer.type;
  }
}
