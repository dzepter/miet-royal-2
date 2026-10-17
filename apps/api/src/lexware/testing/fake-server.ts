import {
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Contract-Fake für Lexware Office (Order §57). Simuliert die tatsächlich
 * genutzten Endpunkte (docs/LEXWARE_API_NOTES.md) mit Pflichtfeldprüfung,
 * Bearer-Pflicht, 2-Req/s-Limit (429), Fehlerinjektion (400/401/403/404/
 * 429/5xx), Timeout NACH erfolgreichem Create (Unknown Outcome) und einer
 * Steuerung über `/__control/*` (nur Tests/E2E). Er ist bewusst nicht
 * bequemer als Lexware: Draft ohne finalize, Adress-Snapshot je Beleg,
 * Version-Konflikte (409), voucherlist-Semantik (overdue transient).
 * Zusätzlich signiert er Webhook-Payloads mit einem eigenen RSA-Schlüssel
 * (öffentlicher Teil über /__control/public-key abrufbar).
 */

export interface FakeContact {
  id: string;
  organizationId: string;
  version: number;
  roles: Record<string, unknown>;
  person?: { salutation?: string; firstName?: string; lastName: string };
  company?: {
    name: string;
    vatRegistrationId?: string;
    taxNumber?: string;
    contactPersons?: {
      salutation?: string;
      firstName?: string;
      lastName: string;
      primary?: boolean;
      emailAddress?: string;
    }[];
  };
  addresses?: {
    billing?: {
      supplement?: string;
      street?: string;
      zip?: string;
      city?: string;
      countryCode: string;
    }[];
  };
  emailAddresses?: Record<string, string[]>;
  phoneNumbers?: Record<string, string[]>;
  note?: string;
  archived: boolean;
  createdDate: string;
  updatedDate: string;
}

export interface FakeInvoice {
  id: string;
  organizationId: string;
  version: number;
  voucherStatus: 'draft' | 'open' | 'paid' | 'voided';
  voucherNumber: string | null;
  voucherDate: string;
  dueDate: string | null;
  address: Record<string, unknown>;
  lineItems: Record<string, unknown>[];
  totalPrice: {
    currency: string;
    totalNetAmount: number;
    totalGrossAmount: number;
    totalTaxAmount: number;
  };
  taxConditions: Record<string, unknown>;
  shippingConditions: Record<string, unknown>;
  paymentConditions: Record<string, unknown> | undefined;
  title?: string;
  introduction?: string;
  remark?: string;
  createdDate: string;
  updatedDate: string;
  /** Zahlungen in Cent (Test-Steuerung). */
  paidCents: number;
  paidDate: string | null;
  deleted: boolean;
}

export interface FakeSubscription {
  subscriptionId: string;
  organizationId: string;
  eventType: string;
  callbackUrl: string;
  createdDate: string;
}

export interface FailureInjection {
  /** Pfad-Regex (gegen `${method} ${pathname}`) und Statuscode; `times` = wie oft. */
  match: string;
  status: number;
  times: number;
  retryAfterSeconds?: number;
  /** 'after_create': Antwort verschlucken, Ressource trotzdem anlegen (Unknown Outcome). */
  mode?: 'status' | 'hang' | 'after_create';
  body?: unknown;
}

export interface FakeLexwareOptions {
  organizationId?: string;
  companyName?: string;
  taxType?: 'net' | 'gross' | 'vatfree';
  smallBusiness?: boolean;
  apiKey?: string;
  /** Rate-Limit-Simulation (2/s) – Default an. */
  rateLimit?: boolean;
  /** Zahlungsziel in Tagen für dueDate. */
  paymentTermDays?: number;
  /** Festes Schlüsselpaar (PEM, PKCS#8) für reproduzierbare Webhook-Signaturen (E2E) – nur Fake, kein Secret. */
  privateKeyPem?: string;
}

export class FakeLexwareServer {
  readonly organizationId: string;
  readonly connectionId = randomUUID();
  readonly apiKey: string;
  companyName: string;
  taxType: 'net' | 'gross' | 'vatfree';
  smallBusiness: boolean;
  rateLimitEnabled: boolean;
  paymentTermDays: number;
  readonly contacts = new Map<string, FakeContact>();
  readonly invoices = new Map<string, FakeInvoice>();
  readonly subscriptions = new Map<string, FakeSubscription>();
  readonly failures: FailureInjection[] = [];
  readonly requestLog: { method: string; path: string; status: number; at: number }[] = [];
  /** Letzter empfangener Invoice-POST-Body (Tests prüfen Felder/Snapshot). */
  lastInvoiceBody: unknown = null;
  lastContactBody: unknown = null;
  private readonly privateKey: KeyObject;
  readonly publicKeyPem: string;
  private server: Server | null = null;
  private invoiceCounter = 0;
  private readonly recentRequests: number[] = [];
  /** Für 403-Simulation: fehlende Berechtigung je Pfadpräfix. */
  readonly deniedScopes = new Set<string>();
  revoked = false;

  constructor(private readonly options: FakeLexwareOptions = {}) {
    this.organizationId = options.organizationId ?? randomUUID();
    this.apiKey = options.apiKey ?? `fake-lexware-key-${randomUUID()}`;
    this.companyName = options.companyName ?? 'Miet-Royal Testfirma (FAKE)';
    this.taxType = options.taxType ?? 'net';
    this.smallBusiness = options.smallBusiness ?? false;
    this.rateLimitEnabled = options.rateLimit ?? true;
    this.paymentTermDays = options.paymentTermDays ?? 14;
    if (options.privateKeyPem !== undefined) {
      this.privateKey = createPrivateKey(options.privateKeyPem);
      this.publicKeyPem = createPublicKey(this.privateKey)
        .export({ format: 'pem', type: 'spki' })
        .toString();
    } else {
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      this.privateKey = pair.privateKey;
      this.publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    }
  }

  async start(port = 0): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        res.statusCode = 500;
        res.end(
          JSON.stringify({
            message: 'fake crashed',
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', () => resolve()));
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (this.server === null) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Signierter Webhook-Body (kompaktes JSON) + Header wie Lexware. */
  signWebhook(payload: {
    eventType: string;
    resourceId: string;
    eventDate?: string;
    organizationId?: string;
  }): {
    body: string;
    signature: string;
  } {
    const body = JSON.stringify({
      organizationId: payload.organizationId ?? this.organizationId,
      eventType: payload.eventType,
      resourceId: payload.resourceId,
      eventDate: payload.eventDate ?? new Date().toISOString(),
    });
    const signer = createSign('RSA-SHA512');
    signer.update(Buffer.from(body, 'utf8'));
    signer.end();
    return { body, signature: signer.sign(this.privateKey).toString('base64') };
  }

  // ── Test-Steuerung (auch über HTTP /__control/*) ──
  setInvoicePaid(invoiceId: string, paidDate = new Date().toISOString()): void {
    const invoice = this.invoices.get(invoiceId);
    if (invoice === undefined) throw new Error('invoice fehlt');
    invoice.voucherStatus = 'paid';
    invoice.paidCents = Math.round(invoice.totalPrice.totalGrossAmount * 100);
    invoice.paidDate = paidDate;
    invoice.updatedDate = new Date().toISOString();
  }

  setInvoiceVoided(invoiceId: string): void {
    const invoice = this.invoices.get(invoiceId);
    if (invoice === undefined) throw new Error('invoice fehlt');
    invoice.voucherStatus = 'voided';
    invoice.updatedDate = new Date().toISOString();
  }

  deleteInvoice(invoiceId: string): void {
    const invoice = this.invoices.get(invoiceId);
    if (invoice === undefined) throw new Error('invoice fehlt');
    invoice.deleted = true;
  }

  setDueDate(invoiceId: string, isoDate: string): void {
    const invoice = this.invoices.get(invoiceId);
    if (invoice === undefined) throw new Error('invoice fehlt');
    invoice.dueDate = isoDate;
  }

  seedContact(
    input: Partial<FakeContact> & { lastName?: string; email?: string; companyName?: string },
  ): FakeContact {
    const now = new Date().toISOString();
    const contact: FakeContact = {
      id: input.id ?? randomUUID(),
      organizationId: this.organizationId,
      version: input.version ?? 1,
      roles: input.roles ?? { customer: {} },
      ...(input.company !== undefined
        ? { company: input.company }
        : input.companyName !== undefined
          ? { company: { name: input.companyName } }
          : {}),
      ...(input.person !== undefined
        ? { person: input.person }
        : input.companyName === undefined && input.company === undefined
          ? { person: { lastName: input.lastName ?? 'Muster' } }
          : {}),
      ...(input.addresses === undefined ? {} : { addresses: input.addresses }),
      emailAddresses:
        input.emailAddresses ?? (input.email === undefined ? {} : { business: [input.email] }),
      ...(input.phoneNumbers === undefined ? {} : { phoneNumbers: input.phoneNumbers }),
      archived: input.archived ?? false,
      createdDate: now,
      updatedDate: now,
    };
    this.contacts.set(contact.id, contact);
    return contact;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const body: unknown = rawBody === '' ? undefined : safeParse(rawBody);

    const send = (status: number, payload?: unknown, headers: Record<string, string> = {}) => {
      this.requestLog.push({ method, path: url.pathname, status, at: Date.now() });
      res.statusCode = status;
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      if (payload === undefined) {
        res.end();
      } else if (payload instanceof Uint8Array) {
        res.setHeader('content-type', 'application/pdf');
        res.end(Buffer.from(payload));
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      }
    };
    const regularError = (status: number, message: string, details?: unknown) =>
      send(status, {
        timestamp: new Date().toISOString(),
        status,
        error: message,
        path: url.pathname,
        traceId: randomUUID(),
        message,
        ...(details === undefined ? {} : { details }),
      });

    if (url.pathname.startsWith('/__control/')) {
      return this.control(url, method, body, send);
    }

    // Auth
    const auth = req.headers.authorization;
    if (this.revoked || auth !== `Bearer ${this.apiKey}`) {
      return send(401, { message: 'Unauthorized' });
    }
    // Fehlerinjektion
    const key = `${method} ${url.pathname}`;
    const failureIndex = this.failures.findIndex(
      (f) => f.times > 0 && new RegExp(f.match).test(key),
    );
    const failure = failureIndex >= 0 ? this.failures[failureIndex] : undefined;
    if (failure !== undefined && failure.mode !== 'after_create') {
      failure.times -= 1;
      if (failure.mode === 'hang') {
        // Verbindung offen halten, bis der Client abbricht (Timeout).
        req.on('close', () => undefined);
        return;
      }
      const headers: Record<string, string> = {};
      if (failure.retryAfterSeconds !== undefined)
        headers['retry-after'] = String(failure.retryAfterSeconds);
      return send(
        failure.status,
        failure.body ?? { message: `injected ${failure.status}` },
        headers,
      );
    }
    // Rate limit 2/s
    if (this.rateLimitEnabled) {
      const now = Date.now();
      while (this.recentRequests.length > 0 && this.recentRequests[0]! < now - 1000)
        this.recentRequests.shift();
      if (this.recentRequests.length >= 2) {
        this.requestLog.push({ method, path: url.pathname, status: 429, at: now });
        res.statusCode = 429;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ message: 'Rate limit exceeded' }));
        return;
      }
      this.recentRequests.push(now);
    }
    // Scope-Simulation (403)
    for (const denied of this.deniedScopes) {
      if (url.pathname.startsWith(denied)) return send(403, { message: 'insufficient scope' });
    }
    if (
      method !== 'GET' &&
      method !== 'DELETE' &&
      req.headers['content-type'] !== 'application/json'
    ) {
      return send(415, { message: 'Missing Content-Type header for POST and PUT requests' });
    }

    const parts = url.pathname.split('/').filter(Boolean); // ['v1', 'contacts', id?]
    if (parts[0] !== 'v1') return send(404, { message: 'Not found' });
    const resource = parts[1];
    const id = parts[2];
    const sub = parts[3];

    if (resource === 'profile' && method === 'GET') {
      return send(200, {
        organizationId: this.organizationId,
        companyName: this.companyName,
        created: {
          userId: randomUUID(),
          userName: 'Fake Nutzer',
          userEmail: 'fake@example.invalid',
          date: new Date(0).toISOString(),
        },
        connectionId: this.connectionId,
        features: [],
        businessFeatures: ['INVOICING', 'INVOICING_PRO', 'BOOKKEEPING'],
        subscriptionStatus: 'active',
        taxType: this.taxType,
        smallBusiness: this.smallBusiness,
      });
    }

    if (resource === 'contacts') {
      if (method === 'GET' && id === undefined) {
        const email = url.searchParams.get('email')?.toLowerCase();
        const name = url.searchParams.get('name')?.toLowerCase();
        if ((email !== undefined && email.length < 3) || (name !== undefined && name.length < 3)) {
          return regularError(400, 'filter too short');
        }
        const customer = url.searchParams.get('customer');
        const all = [...this.contacts.values()].filter((c) => !c.archived);
        const filtered = all.filter((c) => {
          if (customer === 'true' && c.roles.customer === undefined) return false;
          if (email !== undefined) {
            const mails = Object.values(c.emailAddresses ?? {})
              .flat()
              .map((m) => m.toLowerCase());
            const cp = (c.company?.contactPersons ?? []).map((p) =>
              (p.emailAddress ?? '').toLowerCase(),
            );
            if (![...mails, ...cp].some((m) => m.includes(email))) return false;
          }
          if (name !== undefined) {
            const hay = [c.company?.name, c.person?.firstName, c.person?.lastName]
              .filter((x): x is string => typeof x === 'string')
              .join(' ')
              .toLowerCase();
            if (!hay.includes(name)) return false;
          }
          return true;
        });
        const size = Math.min(250, Number(url.searchParams.get('size') ?? 25));
        const page = Number(url.searchParams.get('page') ?? 0);
        const content = filtered.slice(page * size, page * size + size);
        return send(200, {
          content,
          totalPages: Math.ceil(filtered.length / size),
          totalElements: filtered.length,
          last: (page + 1) * size >= filtered.length,
          size,
          number: page,
          first: page === 0,
          numberOfElements: content.length,
        });
      }
      if (method === 'GET' && id !== undefined) {
        const contact = this.contacts.get(id);
        return contact === undefined ? regularError(404, 'contact not found') : send(200, contact);
      }
      if (method === 'POST') {
        this.lastContactBody = body;
        const problem = validateContact(body);
        if (problem !== null)
          return send(400, {
            IssueList: [{ i18nKey: problem, source: problem, type: 'validation_failure' }],
          });
        const input = body as Record<string, unknown>;
        const now = new Date().toISOString();
        const contact: FakeContact = {
          ...(input as Partial<FakeContact>),
          id: randomUUID(),
          organizationId: this.organizationId,
          version: 1,
          roles: input.roles as Record<string, unknown>,
          archived: false,
          createdDate: now,
          updatedDate: now,
        } as FakeContact;
        this.contacts.set(contact.id, contact);
        if (failure !== undefined && failure.mode === 'after_create') {
          failure.times -= 1;
          req.on('close', () => undefined);
          return; // Unknown outcome: angelegt, aber keine Antwort
        }
        return send(201, {
          id: contact.id,
          resourceUri: `${this.baseUrlOf(req)}/v1/contacts/${contact.id}`,
          createdDate: now,
          updatedDate: now,
          version: 1,
        });
      }
      if (method === 'PUT' && id !== undefined) {
        const existing = this.contacts.get(id);
        if (existing === undefined) return regularError(404, 'contact not found');
        const input = body as Record<string, unknown>;
        if (typeof input?.version !== 'number' || input.version !== existing.version) {
          return regularError(409, 'version conflict');
        }
        const problem = validateContact(body);
        if (problem !== null)
          return send(400, {
            IssueList: [{ i18nKey: problem, source: problem, type: 'validation_failure' }],
          });
        const updated: FakeContact = {
          ...(input as Partial<FakeContact>),
          id,
          organizationId: this.organizationId,
          version: existing.version + 1,
          roles: input.roles as Record<string, unknown>,
          archived: existing.archived,
          createdDate: existing.createdDate,
          updatedDate: new Date().toISOString(),
        } as FakeContact;
        this.contacts.set(id, updated);
        return send(200, {
          id,
          resourceUri: `${this.baseUrlOf(req)}/v1/contacts/${id}`,
          createdDate: updated.createdDate,
          updatedDate: updated.updatedDate,
          version: updated.version,
        });
      }
    }

    if (resource === 'invoices') {
      if (method === 'POST' && id === undefined) {
        this.lastInvoiceBody = body;
        const finalize = url.searchParams.get('finalize') === 'true';
        const problem = validateInvoice(body, this.taxType, this.contacts);
        if (problem !== null) {
          return regularError(400, 'validation failed', [
            { violation: problem.violation, field: problem.field, message: 'not for end-users' },
          ]);
        }
        const input = body as Record<string, unknown>;
        const totals = computeTotals(input.lineItems as Record<string, unknown>[], this.taxType);
        if (totals.totalGrossAmount < 0) {
          return regularError(400, 'validation failed', [
            { violation: 'NEGATIVE_TOTAL', field: 'totalPrice', message: '' },
          ]);
        }
        const now = new Date();
        this.invoiceCounter += 1;
        const voucherDate = String(input.voucherDate);
        const invoice: FakeInvoice = {
          id: randomUUID(),
          organizationId: this.organizationId,
          version: 1,
          voucherStatus: finalize ? 'open' : 'draft',
          voucherNumber: finalize
            ? `RE${now.getFullYear()}${String(this.invoiceCounter).padStart(4, '0')}`
            : null,
          voucherDate,
          dueDate: finalize ? addDays(voucherDate, this.paymentTermDays) : null,
          address: input.address as Record<string, unknown>,
          lineItems: input.lineItems as Record<string, unknown>[],
          totalPrice: { currency: 'EUR', ...totals },
          taxConditions: input.taxConditions as Record<string, unknown>,
          shippingConditions: input.shippingConditions as Record<string, unknown>,
          paymentConditions: input.paymentConditions as Record<string, unknown> | undefined,
          ...(typeof input.title === 'string' ? { title: input.title } : {}),
          ...(typeof input.introduction === 'string' ? { introduction: input.introduction } : {}),
          ...(typeof input.remark === 'string' ? { remark: input.remark } : {}),
          createdDate: now.toISOString(),
          updatedDate: now.toISOString(),
          paidCents: 0,
          paidDate: null,
          deleted: false,
        };
        this.invoices.set(invoice.id, invoice);
        if (failure !== undefined && failure.mode === 'after_create') {
          failure.times -= 1;
          req.on('close', () => undefined);
          return; // Unknown outcome
        }
        return send(201, {
          id: invoice.id,
          resourceUri: `${this.baseUrlOf(req)}/v1/invoices/${invoice.id}`,
          createdDate: invoice.createdDate,
          updatedDate: invoice.updatedDate,
          version: 1,
        });
      }
      if (method === 'GET' && id !== undefined && sub === undefined) {
        const invoice = this.invoices.get(id);
        if (invoice === undefined || invoice.deleted) return regularError(404, 'invoice not found');
        return send(200, {
          id: invoice.id,
          organizationId: invoice.organizationId,
          createdDate: invoice.createdDate,
          updatedDate: invoice.updatedDate,
          version: invoice.version,
          language: 'de',
          archived: false,
          voucherStatus: invoice.voucherStatus,
          voucherNumber: invoice.voucherNumber ?? undefined,
          voucherDate: invoice.voucherDate,
          dueDate: invoice.dueDate ?? undefined,
          address: invoice.address,
          lineItems: invoice.lineItems,
          totalPrice: invoice.totalPrice,
          taxConditions: invoice.taxConditions,
          paymentConditions: invoice.paymentConditions,
          shippingConditions: invoice.shippingConditions,
          title: invoice.title,
          introduction: invoice.introduction,
          remark: invoice.remark,
        });
      }
      if (method === 'GET' && id !== undefined && sub === 'file') {
        const invoice = this.invoices.get(id);
        if (invoice === undefined || invoice.deleted) return regularError(404, 'invoice not found');
        if (invoice.voucherStatus === 'draft') return regularError(409, 'draft has no file');
        const accept = req.headers.accept ?? '';
        if (accept !== '*/*' && !accept.includes('application/pdf'))
          return regularError(406, 'media type');
        res.setHeader(
          'content-disposition',
          `attachment; filename="${invoice.voucherNumber ?? 'rechnung'}.pdf"`,
        );
        return send(200, Buffer.from(`%PDF-1.4 FAKE ${invoice.voucherNumber ?? ''}\n`));
      }
    }

    if (resource === 'payments' && method === 'GET' && id !== undefined) {
      const invoice = this.invoices.get(id);
      if (invoice === undefined || invoice.deleted) return regularError(404, 'voucher not found');
      if (invoice.voucherStatus === 'draft') return regularError(406, 'no payment information');
      const grossCents = Math.round(invoice.totalPrice.totalGrossAmount * 100);
      const openCents =
        invoice.voucherStatus === 'voided' ? 0 : Math.max(0, grossCents - invoice.paidCents);
      return send(200, {
        openAmount: openCents / 100,
        currency: 'EUR',
        paymentStatus: openCents === 0 ? 'balanced' : 'openRevenue',
        voucherType: 'invoice',
        voucherStatus: invoice.voucherStatus,
        ...(invoice.paidDate === null ? {} : { paidDate: invoice.paidDate }),
        paymentItems:
          invoice.paidCents > 0
            ? [
                {
                  paymentItemType: 'partPaymentFinancialTransaction',
                  postingDate: invoice.paidDate,
                  amount: invoice.paidCents / 100,
                  currency: 'EUR',
                },
              ]
            : [],
      });
    }

    if (resource === 'voucherlist' && method === 'GET') {
      const types = (url.searchParams.get('voucherType') ?? '').split(',');
      const statuses = (url.searchParams.get('voucherStatus') ?? '').split(',');
      if (types[0] === '' || statuses[0] === '')
        return regularError(400, 'voucherType and voucherStatus required');
      const contactId = url.searchParams.get('contactId');
      const dateFrom = url.searchParams.get('voucherDateFrom');
      const dateTo = url.searchParams.get('voucherDateTo');
      const createdFrom = url.searchParams.get('createdDateFrom');
      const createdTo = url.searchParams.get('createdDateTo');
      const voucherNumber = url.searchParams.get('voucherNumber');
      const today = new Date().toISOString().slice(0, 10);
      const entries = [...this.invoices.values()]
        .filter((i) => !i.deleted)
        .filter(() => types.includes('any') || types.includes('invoice'))
        .filter((i) => {
          const effective =
            i.voucherStatus === 'open' && i.dueDate !== null && i.dueDate.slice(0, 10) < today
              ? 'overdue'
              : i.voucherStatus;
          return (
            statuses.includes('any') ||
            statuses.includes(effective) ||
            (effective === 'overdue' && statuses.includes('open'))
          );
        })
        .filter((i) => contactId === null || i.address.contactId === contactId)
        .filter((i) => dateFrom === null || i.voucherDate.slice(0, 10) >= dateFrom)
        .filter((i) => dateTo === null || i.voucherDate.slice(0, 10) <= dateTo)
        .filter((i) => createdFrom === null || i.createdDate.slice(0, 10) >= createdFrom)
        .filter((i) => createdTo === null || i.createdDate.slice(0, 10) <= createdTo)
        .filter((i) => voucherNumber === null || i.voucherNumber === voucherNumber)
        .map((i) => ({
          id: i.id,
          voucherType: 'invoice',
          voucherStatus:
            i.voucherStatus === 'open' && i.dueDate !== null && i.dueDate.slice(0, 10) < today
              ? 'overdue'
              : i.voucherStatus,
          voucherNumber: i.voucherNumber ?? undefined,
          voucherDate: i.voucherDate,
          createdDate: i.createdDate,
          updatedDate: i.updatedDate,
          dueDate: i.dueDate,
          contactId: (i.address.contactId as string | undefined) ?? null,
          contactName: String(i.address.name ?? ''),
          totalAmount: i.totalPrice.totalGrossAmount,
          openAmount:
            i.voucherStatus === 'voided'
              ? 0
              : Math.max(0, Math.round(i.totalPrice.totalGrossAmount * 100) - i.paidCents) / 100,
          currency: 'EUR',
          archived: false,
        }));
      const size = Math.min(250, Number(url.searchParams.get('size') ?? 25));
      const page = Number(url.searchParams.get('page') ?? 0);
      const content = entries.slice(page * size, page * size + size);
      return send(200, {
        content,
        totalPages: Math.ceil(entries.length / size),
        totalElements: entries.length,
        last: (page + 1) * size >= entries.length,
        number: page,
        size,
      });
    }

    if (resource === 'event-subscriptions') {
      if (method === 'GET' && id === undefined)
        return send(200, { content: [...this.subscriptions.values()] });
      if (method === 'POST') {
        const input = body as Record<string, unknown> | undefined;
        if (typeof input?.eventType !== 'string' || typeof input.callbackUrl !== 'string')
          return regularError(400, 'eventType/callbackUrl required');
        if (!/^https?:\/\//.test(input.callbackUrl))
          return regularError(406, 'callback url not reachable');
        for (const s of this.subscriptions.values()) {
          if (s.eventType === input.eventType && s.callbackUrl === input.callbackUrl)
            return regularError(409, 'subscription exists');
        }
        const now = new Date().toISOString();
        const subscription: FakeSubscription = {
          subscriptionId: randomUUID(),
          organizationId: this.organizationId,
          eventType: input.eventType,
          callbackUrl: input.callbackUrl,
          createdDate: now,
        };
        this.subscriptions.set(subscription.subscriptionId, subscription);
        return send(201, {
          id: subscription.subscriptionId,
          resourceUri: `${this.baseUrlOf(req)}/v1/event-subscriptions/${subscription.subscriptionId}`,
          createdDate: now,
          updatedDate: now,
          version: 0,
        });
      }
      if (method === 'DELETE' && id !== undefined) {
        if (!this.subscriptions.delete(id)) return regularError(404, 'subscription not found');
        return send(204);
      }
    }

    return regularError(404, 'Not found');
  }

  private control(
    url: URL,
    method: string,
    body: unknown,
    send: (status: number, payload?: unknown) => void,
  ): void {
    const action = url.pathname.replace('/__control/', '');
    const input = (body ?? {}) as Record<string, unknown>;
    switch (action) {
      case 'public-key':
        return send(200, {
          publicKeyPem: this.publicKeyPem,
          organizationId: this.organizationId,
          apiKey: this.apiKey,
        });
      case 'fail-next':
        this.failures.push({
          match: String(input.match ?? '.*'),
          status: Number(input.status ?? 500),
          times: Number(input.times ?? 1),
          ...(input.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: Number(input.retryAfterSeconds) }),
          mode: (input.mode as FailureInjection['mode']) ?? 'status',
          ...(input.body === undefined ? {} : { body: input.body }),
        });
        return send(200, { ok: true, failures: this.failures.length });
      case 'invoice-paid':
        this.setInvoicePaid(
          String(input.invoiceId),
          typeof input.paidDate === 'string' ? input.paidDate : undefined,
        );
        return send(200, { ok: true });
      case 'invoice-voided':
        this.setInvoiceVoided(String(input.invoiceId));
        return send(200, { ok: true });
      case 'invoice-deleted':
        this.deleteInvoice(String(input.invoiceId));
        return send(200, { ok: true });
      case 'invoice-due-date':
        this.setDueDate(String(input.invoiceId), String(input.dueDate));
        return send(200, { ok: true });
      case 'seed-contact':
        return send(
          200,
          this.seedContact(
            input as Partial<FakeContact> & {
              lastName?: string;
              email?: string;
              companyName?: string;
            },
          ),
        );
      case 'sign-webhook':
        return send(
          200,
          this.signWebhook(
            input as {
              eventType: string;
              resourceId: string;
              eventDate?: string;
              organizationId?: string;
            },
          ),
        );
      case 'invoices':
        return send(200, {
          invoices: [...this.invoices.values()].map((i) => ({
            id: i.id,
            voucherNumber: i.voucherNumber,
            voucherStatus: i.voucherStatus,
            totalGrossAmount: i.totalPrice.totalGrossAmount,
            remark: i.remark,
            address: i.address,
            lineItems: i.lineItems,
          })),
        });
      case 'contacts':
        return send(200, { contacts: [...this.contacts.values()] });
      case 'subscriptions':
        return send(200, { subscriptions: [...this.subscriptions.values()] });
      case 'request-log':
        return send(200, { requests: this.requestLog });
      case 'set-rate-limit':
        this.rateLimitEnabled = Boolean(input.enabled);
        return send(200, { ok: true });
      case 'revoke':
        this.revoked = Boolean(input.revoked ?? true);
        return send(200, { ok: true });
      case 'deny-scope':
        if (typeof input.pathPrefix === 'string') this.deniedScopes.add(input.pathPrefix);
        return send(200, { ok: true });
      case 'profile':
        if (typeof input.taxType === 'string')
          this.taxType = input.taxType as FakeLexwareServer['taxType'];
        if (typeof input.smallBusiness === 'boolean') this.smallBusiness = input.smallBusiness;
        if (typeof input.companyName === 'string') this.companyName = input.companyName;
        return send(200, { ok: true });
      case 'reset':
        this.contacts.clear();
        this.invoices.clear();
        this.subscriptions.clear();
        this.failures.length = 0;
        this.requestLog.length = 0;
        this.deniedScopes.clear();
        this.revoked = false;
        this.invoiceCounter = 0;
        this.lastInvoiceBody = null;
        this.lastContactBody = null;
        return send(200, { ok: true });
      default:
        return send(404, { message: 'unknown control action' });
    }
  }

  private baseUrlOf(req: IncomingMessage): string {
    return `http://${req.headers.host ?? '127.0.0.1'}`;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function addDays(isoDateTime: string, days: number): string {
  const d = new Date(isoDateTime);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function validateContact(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return 'body';
  const c = body as Record<string, unknown>;
  if (typeof c.version !== 'number') return 'version';
  const roles = c.roles as Record<string, unknown> | undefined;
  if (roles === undefined || (roles.customer === undefined && roles.vendor === undefined))
    return 'roles';
  const hasPerson = c.person !== undefined;
  const hasCompany = c.company !== undefined;
  if (hasPerson === hasCompany) return 'person_or_company';
  if (hasPerson && typeof (c.person as Record<string, unknown>).lastName !== 'string')
    return 'person.lastName';
  if (hasCompany && typeof (c.company as Record<string, unknown>).name !== 'string')
    return 'company.name';
  const addresses = c.addresses as Record<string, unknown[]> | undefined;
  if (addresses !== undefined) {
    for (const key of ['billing', 'shipping']) {
      const list = addresses[key];
      if (list === undefined) continue;
      if (list.length > 1) return `addresses.${key}.size`;
      const entry = list[0] as Record<string, unknown> | undefined;
      if (entry !== undefined && typeof entry.countryCode !== 'string')
        return `addresses.${key}.countryCode`;
    }
  }
  const emails = c.emailAddresses as Record<string, unknown[]> | undefined;
  if (emails !== undefined && Object.values(emails).some((l) => l.length > 1))
    return 'emailAddresses.size';
  return null;
}

function validateInvoice(
  body: unknown,
  taxType: string,
  contacts: Map<string, FakeContact>,
): { violation: string; field: string } | null {
  if (body === null || typeof body !== 'object') return { violation: 'NOTNULL', field: 'body' };
  const i = body as Record<string, unknown>;
  for (const readOnly of [
    'id',
    'version',
    'voucherStatus',
    'voucherNumber',
    'dueDate',
    'taxAmounts',
    'closingInvoice',
    'claimedGrossAmount',
    'files',
    'organizationId',
  ]) {
    if (i[readOnly] !== undefined) return { violation: 'READONLY', field: readOnly };
  }
  if (
    typeof i.voucherDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(i.voucherDate)
  ) {
    return { violation: 'FORMAT', field: 'voucherDate' };
  }
  const address = i.address as Record<string, unknown> | undefined;
  if (address === undefined) return { violation: 'NOTNULL', field: 'address' };
  if (typeof address.contactId === 'string') {
    if (!contacts.has(address.contactId))
      return { violation: 'NOT_FOUND', field: 'address.contactId' };
  } else if (typeof address.name !== 'string' || typeof address.countryCode !== 'string') {
    return { violation: 'NOTNULL', field: 'address.name' };
  }
  const lineItems = i.lineItems as Record<string, unknown>[] | undefined;
  if (!Array.isArray(lineItems) || lineItems.length === 0)
    return { violation: 'NOTNULL', field: 'lineItems' };
  if (lineItems.length > 300) return { violation: 'SIZE', field: 'lineItems' };
  for (const [index, item] of lineItems.entries()) {
    if (item.type !== 'custom' && item.type !== 'text')
      return { violation: 'UNSUPPORTED', field: `lineItems[${index}].type` };
    if (typeof item.name !== 'string' || item.name === '')
      return { violation: 'NOTNULL', field: `lineItems[${index}].name` };
    if (item.type === 'custom') {
      if (typeof item.quantity !== 'number')
        return { violation: 'NOTNULL', field: `lineItems[${index}].quantity` };
      if (typeof item.unitName !== 'string')
        return { violation: 'NOTNULL', field: `lineItems[${index}].unitName` };
      const unitPrice = item.unitPrice as Record<string, unknown> | undefined;
      if (unitPrice === undefined)
        return { violation: 'NOTNULL', field: `lineItems[${index}].unitPrice` };
      if (unitPrice.currency !== 'EUR')
        return { violation: 'INVALID', field: `lineItems[${index}].unitPrice.currency` };
      if (typeof unitPrice.taxRatePercentage !== 'number')
        return { violation: 'NOTNULL', field: `lineItems[${index}].unitPrice.taxRatePercentage` };
      if (taxType === 'gross' && typeof unitPrice.grossAmount !== 'number')
        return { violation: 'NOTNULL', field: `lineItems[${index}].unitPrice.grossAmount` };
      if (taxType !== 'gross' && typeof unitPrice.netAmount !== 'number')
        return { violation: 'NOTNULL', field: `lineItems[${index}].unitPrice.netAmount` };
      if (taxType === 'vatfree' && unitPrice.taxRatePercentage !== 0)
        return { violation: 'INVALID', field: `lineItems[${index}].unitPrice.taxRatePercentage` };
      if (![0, 7, 19].includes(unitPrice.taxRatePercentage as number))
        return {
          violation: 'INVALID_TAX_RATE',
          field: `lineItems[${index}].unitPrice.taxRatePercentage`,
        };
    }
  }
  const totalPrice = i.totalPrice as Record<string, unknown> | undefined;
  if (totalPrice?.currency !== 'EUR') return { violation: 'NOTNULL', field: 'totalPrice.currency' };
  for (const ro of ['totalNetAmount', 'totalGrossAmount', 'totalTaxAmount'])
    if (totalPrice[ro] !== undefined) return { violation: 'READONLY', field: `totalPrice.${ro}` };
  const taxConditions = i.taxConditions as Record<string, unknown> | undefined;
  if (typeof taxConditions?.taxType !== 'string')
    return { violation: 'NOTNULL', field: 'taxConditions.taxType' };
  if (taxConditions.taxType !== taxType)
    return { violation: 'TAX_TYPE_MISMATCH', field: 'taxConditions.taxType' };
  const shipping = i.shippingConditions as Record<string, unknown> | undefined;
  if (typeof shipping?.shippingType !== 'string')
    return { violation: 'NOTNULL', field: 'shippingConditions.shippingType' };
  if (
    ['service', 'serviceperiod', 'delivery', 'deliveryperiod'].includes(shipping.shippingType) &&
    typeof shipping.shippingDate !== 'string'
  )
    return { violation: 'NOTNULL', field: 'shippingConditions.shippingDate' };
  if (
    ['serviceperiod', 'deliveryperiod'].includes(shipping.shippingType) &&
    typeof shipping.shippingEndDate !== 'string'
  )
    return { violation: 'NOTNULL', field: 'shippingConditions.shippingEndDate' };
  if (i.language !== undefined && i.language !== 'de')
    return { violation: 'INVALID', field: 'language' };
  return null;
}

/** Summen wie Lexware: je Position Netto × Menge (2 Dezimalstellen), Steuer je Position gerundet. */
function computeTotals(
  lineItems: Record<string, unknown>[],
  taxType: string,
): { totalNetAmount: number; totalGrossAmount: number; totalTaxAmount: number } {
  let netCents = 0;
  let taxCents = 0;
  let grossCents = 0;
  for (const item of lineItems) {
    if (item.type !== 'custom') continue;
    const unitPrice = item.unitPrice as Record<string, number>;
    const quantity = Number(item.quantity);
    const rate = Number(unitPrice.taxRatePercentage);
    if (taxType === 'gross') {
      const lineGross = Math.round(Number(unitPrice.grossAmount) * 100 * quantity);
      const lineNet = Math.round(lineGross / (1 + rate / 100));
      grossCents += lineGross;
      netCents += lineNet;
      taxCents += lineGross - lineNet;
    } else {
      const lineNet = Math.round(Number(unitPrice.netAmount) * 100 * quantity);
      const lineTax = Math.round((lineNet * rate) / 100);
      netCents += lineNet;
      taxCents += lineTax;
      grossCents += lineNet + lineTax;
    }
  }
  return {
    totalNetAmount: netCents / 100,
    totalGrossAmount: grossCents / 100,
    totalTaxAmount: taxCents / 100,
  };
}
