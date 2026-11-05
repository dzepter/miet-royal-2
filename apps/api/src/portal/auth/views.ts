import type { AppEnvironment } from '@mietroyal/config';
import type { Customer } from '@mietroyal/database';
import { PORTAL_MESSAGES } from '../types.ts';

/**
 * Phase 15 (Design §6, AUTH): kundensichere DTOs der Auth-/Profil-Grenze.
 * Explizite Builder – nie Zeilen spreaden, nie Staff-Felder (deletedBy, IDs
 * anderer Objekte, phoneNormalized) durchreichen.
 */
export interface PortalMeView {
  customer: { displayName: string; type: 'private' | 'organization'; email: string };
  session: { expiresAt: string; reauthFresh: boolean };
  links: { newInquiryUrl: string | null; phoneNumber: string | null };
  environment: AppEnvironment;
}

export interface PortalProfileView {
  type: 'private' | 'organization';
  firstName: string | null;
  lastName: string | null;
  organizationName: string | null;
  contactPerson: string | null;
  email: string;
  phone: string | null;
  billingStreet: string | null;
  billingPostalCode: string | null;
  billingCity: string | null;
  billingCountry: string | null;
  vatId: string | null;
  department: string | null;
  costCenter: string | null;
  orderReference: string | null;
  /** PORTAL_MESSAGES.PROFILE_HINT */
  hint: string;
}

/** Anzeigename für Portal und Portal-Mails: „Max Mustermann“ bzw. Organisationsname. */
export function portalCustomerName(customer: {
  type: 'private' | 'organization';
  firstName: string | null;
  lastName: string | null;
  organizationName: string | null;
}): string {
  if (customer.type === 'organization') return customer.organizationName ?? 'Organisation';
  return `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim();
}

export function buildPortalProfileView(customer: Customer): PortalProfileView {
  return {
    type: customer.type,
    firstName: customer.firstName,
    lastName: customer.lastName,
    organizationName: customer.organizationName,
    contactPerson: customer.contactPerson,
    email: customer.email ?? '',
    phone: customer.phone,
    billingStreet: customer.billingStreet,
    billingPostalCode: customer.billingPostalCode,
    billingCity: customer.billingCity,
    billingCountry: customer.billingCountry,
    vatId: customer.vatId,
    department: customer.department,
    costCenter: customer.costCenter,
    orderReference: customer.orderReference,
    hint: PORTAL_MESSAGES.PROFILE_HINT,
  };
}

export function buildPortalMeView(input: {
  customer: Customer;
  sessionExpiresAt: Date;
  reauthFresh: boolean;
  links: { newInquiryUrl: string | null; phoneNumber: string | null };
  environment: AppEnvironment;
}): PortalMeView {
  return {
    customer: {
      displayName: portalCustomerName(input.customer),
      type: input.customer.type,
      email: input.customer.email ?? '',
    },
    session: { expiresAt: input.sessionExpiresAt.toISOString(), reauthFresh: input.reauthFresh },
    links: { newInquiryUrl: input.links.newInquiryUrl, phoneNumber: input.links.phoneNumber },
    environment: input.environment,
  };
}
