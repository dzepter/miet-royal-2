import { randomUUID } from 'node:crypto';
import { z } from '@mietroyal/validation';
import { classifyStatus, extractViolations, LexwareApiError } from './errors.ts';
import type { LexwareThrottle } from './rate-limiter.ts';

/**
 * Zentrale Transportgrenze zu Lexware Office (Order §10). Einziger Ort mit
 * fetch() gegen Lexware: Bearer-Auth, HTTPS/JSON, Timeout, Fehlerklassifikation,
 * Rate-Limit-Slot (Throttle), Retry-After, Response-Validierung (zod),
 * Correlation-ID; der API-Key verlässt diese Klasse nie (kein Log, kein
 * Fehlertext). Retries macht der Client NICHT selbst – das entscheidet die
 * Queue/der Aufrufer anhand `LexwareApiError.transient`.
 */

export interface LexwareClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  throttle: LexwareThrottle;
  fetchImpl?: typeof fetch;
  /** Nur Logs ohne Secrets/Kundendaten: Methode, Pfad (ohne Query), Status, Dauer, Correlation-ID. */
  logger?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

export interface LexwareRequest<T> {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  schema: z.ZodType<T>;
  /** Für Dateidownloads: */
  accept?: string;
}

export interface LexwareResponse<T> {
  status: number;
  data: T;
  headers: Headers;
  correlationId: string;
}

// ── Response-Schemata (nur die genutzten Felder; unbekannte werden ignoriert) ──
export const profileSchema = z.object({
  organizationId: z.string().min(1),
  companyName: z.string().default(''),
  connectionId: z.string().optional(),
  taxType: z.string().optional(),
  smallBusiness: z.boolean().optional(),
  businessFeatures: z.array(z.string()).optional(),
  distanceSalesPrinciple: z.string().optional(),
  subscriptionStatus: z.string().optional(),
});
export type LexwareProfile = z.infer<typeof profileSchema>;

export const actionResultSchema = z.object({
  id: z.string().min(1),
  resourceUri: z.string().optional(),
  createdDate: z.string().optional(),
  updatedDate: z.string().optional(),
  version: z.number().optional(),
});
export type LexwareActionResult = z.infer<typeof actionResultSchema>;

export const contactSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().optional(),
  version: z.number(),
  roles: z.record(z.string(), z.unknown()).optional(),
  person: z
    .object({
      salutation: z.string().optional(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
    })
    .optional(),
  company: z
    .object({
      name: z.string().optional(),
      vatRegistrationId: z.string().optional(),
      taxNumber: z.string().optional(),
      contactPersons: z
        .array(
          z.object({
            salutation: z.string().optional(),
            firstName: z.string().optional(),
            lastName: z.string().optional(),
            primary: z.boolean().optional(),
            emailAddress: z.string().optional(),
            phoneNumber: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  addresses: z
    .object({
      billing: z
        .array(
          z.object({
            supplement: z.string().optional(),
            street: z.string().optional(),
            zip: z.string().optional(),
            city: z.string().optional(),
            countryCode: z.string().optional(),
          }),
        )
        .optional(),
      shipping: z.array(z.record(z.string(), z.unknown())).optional(),
    })
    .optional(),
  emailAddresses: z.record(z.string(), z.array(z.string())).optional(),
  phoneNumbers: z.record(z.string(), z.array(z.string())).optional(),
  note: z.string().optional(),
  archived: z.boolean().optional(),
});
export type LexwareContact = z.infer<typeof contactSchema>;

export const contactPageSchema = z.object({
  content: z.array(contactSchema),
  totalPages: z.number().optional(),
  totalElements: z.number().optional(),
  last: z.boolean().optional(),
  number: z.number().optional(),
});

export const invoiceSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().optional(),
  version: z.number().optional(),
  voucherStatus: z.string(),
  voucherNumber: z.string().optional(),
  voucherDate: z.string().optional(),
  dueDate: z.string().optional(),
  address: z.record(z.string(), z.unknown()).optional(),
  lineItems: z.array(z.record(z.string(), z.unknown())).optional(),
  totalPrice: z
    .object({
      currency: z.string().optional(),
      totalNetAmount: z.union([z.number(), z.string()]).optional(),
      totalGrossAmount: z.union([z.number(), z.string()]).optional(),
      totalTaxAmount: z.union([z.number(), z.string()]).optional(),
    })
    .optional(),
  taxConditions: z.record(z.string(), z.unknown()).optional(),
  remark: z.string().optional(),
  introduction: z.string().optional(),
  title: z.string().optional(),
  archived: z.boolean().optional(),
});
export type LexwareInvoice = z.infer<typeof invoiceSchema>;

export const paymentSchema = z.object({
  openAmount: z.union([z.number(), z.string()]),
  currency: z.string().optional(),
  paymentStatus: z.string(),
  voucherType: z.string().optional(),
  voucherStatus: z.string(),
  paidDate: z.string().optional(),
  paymentItems: z
    .array(
      z.object({
        paymentItemType: z.string().optional(),
        postingDate: z.string().optional(),
        amount: z.union([z.number(), z.string()]).optional(),
        currency: z.string().optional(),
      }),
    )
    .optional(),
});
export type LexwarePayment = z.infer<typeof paymentSchema>;

export const voucherlistEntrySchema = z.object({
  id: z.string().min(1),
  voucherType: z.string(),
  voucherStatus: z.string(),
  voucherNumber: z.string().optional(),
  voucherDate: z.string().optional(),
  createdDate: z.string().optional(),
  updatedDate: z.string().optional(),
  dueDate: z.string().nullable().optional(),
  contactId: z.string().nullable().optional(),
  contactName: z.string().optional(),
  totalAmount: z.union([z.number(), z.string()]).optional(),
  openAmount: z.union([z.number(), z.string()]).nullable().optional(),
  currency: z.string().optional(),
  archived: z.boolean().optional(),
});
export const voucherlistPageSchema = z.object({
  content: z.array(voucherlistEntrySchema),
  totalPages: z.number().optional(),
  totalElements: z.number().optional(),
  last: z.boolean().optional(),
  number: z.number().optional(),
});
export type LexwareVoucherlistEntry = z.infer<typeof voucherlistEntrySchema>;

export const eventSubscriptionSchema = z.object({
  subscriptionId: z.string().min(1),
  organizationId: z.string().optional(),
  createdDate: z.string().optional(),
  eventType: z.string(),
  callbackUrl: z.string(),
});
export const eventSubscriptionListSchema = z.object({ content: z.array(eventSubscriptionSchema) });
export type LexwareEventSubscription = z.infer<typeof eventSubscriptionSchema>;

export const emptySchema = z.unknown();

export class LexwareClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: LexwareClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!/^https?:\/\//.test(options.baseUrl)) throw new Error('Lexware baseUrl muss http(s) sein');
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  async request<T>(input: LexwareRequest<T>): Promise<LexwareResponse<T>> {
    const correlationId = randomUUID();
    const url = new URL(`${this.options.baseUrl}${input.path}`);
    if (input.query !== undefined) {
      for (const [key, value] of Object.entries(input.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.apiKey}`,
      accept: input.accept ?? 'application/json',
      'x-mr-correlation-id': correlationId,
    };
    if (input.body !== undefined) headers['content-type'] = 'application/json';

    await this.options.throttle.acquire();
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: input.method,
        headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      const timedOut = controller.signal.aborted;
      this.log(
        'warn',
        input,
        undefined,
        startedAt,
        correlationId,
        timedOut ? 'timeout' : 'network',
      );
      throw new LexwareApiError(
        timedOut ? 'timeout' : 'network',
        timedOut ? 'Lexware antwortet nicht (Timeout).' : 'Lexware nicht erreichbar.',
      );
    }
    clearTimeout(timer);

    if (!response.ok) {
      const kind = classifyStatus(response.status);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const retryAfter = response.headers.get('retry-after');
      const retryAfterMs =
        retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
      const traceId =
        body !== null &&
        typeof body === 'object' &&
        typeof (body as Record<string, unknown>).traceId === 'string'
          ? ((body as Record<string, unknown>).traceId as string)
          : undefined;
      this.log('warn', input, response.status, startedAt, correlationId, kind);
      throw new LexwareApiError(kind, `Lexware-Antwort ${response.status}.`, {
        status: response.status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        violations: extractViolations(body),
        ...(traceId === undefined ? {} : { traceId }),
      });
    }

    let raw: unknown;
    if (response.status === 204 || input.method === 'HEAD') {
      raw = null;
    } else if ((input.accept ?? 'application/json') === 'application/json') {
      const text = await response.text();
      raw = text === '' ? null : safeJson(text);
    } else {
      raw = new Uint8Array(await response.arrayBuffer());
    }
    const parsed = input.schema.safeParse(raw);
    if (!parsed.success) {
      this.log('warn', input, response.status, startedAt, correlationId, 'invalid_response');
      throw new LexwareApiError(
        'invalid_response',
        'Lexware-Antwort hat ein unerwartetes Format.',
        {
          status: response.status,
        },
      );
    }
    this.log('info', input, response.status, startedAt, correlationId, 'ok');
    return { status: response.status, data: parsed.data, headers: response.headers, correlationId };
  }

  private log(
    level: 'info' | 'warn',
    input: LexwareRequest<unknown>,
    status: number | undefined,
    startedAt: number,
    correlationId: string,
    outcome: string,
  ): void {
    this.options.logger?.[level](
      {
        lexware: {
          method: input.method,
          path: maskPath(input.path),
          status,
          outcome,
          durationMs: Date.now() - startedAt,
        },
        correlationId,
      },
      'Lexware-Request',
    );
  }

  // ── Fachliche Aufrufe (dünn, Pfade laut docs/LEXWARE_API_NOTES.md) ──

  profile() {
    return this.request({ method: 'GET', path: '/v1/profile', schema: profileSchema });
  }

  searchContacts(query: {
    email?: string;
    name?: string;
    customer?: boolean;
    page?: number;
    size?: number;
  }) {
    return this.request({ method: 'GET', path: '/v1/contacts', query, schema: contactPageSchema });
  }

  getContact(id: string) {
    return this.request({
      method: 'GET',
      path: `/v1/contacts/${encodeURIComponent(id)}`,
      schema: contactSchema,
    });
  }

  createContact(body: unknown) {
    return this.request({ method: 'POST', path: '/v1/contacts', body, schema: actionResultSchema });
  }

  updateContact(id: string, body: unknown) {
    return this.request({
      method: 'PUT',
      path: `/v1/contacts/${encodeURIComponent(id)}`,
      body,
      schema: actionResultSchema,
    });
  }

  createInvoice(body: unknown, finalize: boolean) {
    return this.request({
      method: 'POST',
      path: '/v1/invoices',
      query: finalize ? { finalize: true } : {},
      body,
      schema: actionResultSchema,
    });
  }

  getInvoice(id: string) {
    return this.request({
      method: 'GET',
      path: `/v1/invoices/${encodeURIComponent(id)}`,
      schema: invoiceSchema,
    });
  }

  getInvoiceFile(id: string) {
    return this.request({
      method: 'GET',
      path: `/v1/invoices/${encodeURIComponent(id)}/file`,
      accept: '*/*',
      schema: z.instanceof(Uint8Array),
    });
  }

  getPayment(voucherId: string) {
    return this.request({
      method: 'GET',
      path: `/v1/payments/${encodeURIComponent(voucherId)}`,
      schema: paymentSchema,
    });
  }

  voucherlist(query: {
    voucherType: string;
    voucherStatus: string;
    contactId?: string;
    voucherDateFrom?: string;
    voucherDateTo?: string;
    createdDateFrom?: string;
    createdDateTo?: string;
    voucherNumber?: string;
    page?: number;
    size?: number;
    sort?: string;
  }) {
    return this.request({
      method: 'GET',
      path: '/v1/voucherlist',
      query,
      schema: voucherlistPageSchema,
    });
  }

  listEventSubscriptions() {
    return this.request({
      method: 'GET',
      path: '/v1/event-subscriptions',
      schema: eventSubscriptionListSchema,
    });
  }

  createEventSubscription(body: { eventType: string; callbackUrl: string }) {
    return this.request({
      method: 'POST',
      path: '/v1/event-subscriptions',
      body,
      schema: actionResultSchema,
    });
  }

  deleteEventSubscription(id: string) {
    return this.request({
      method: 'DELETE',
      path: `/v1/event-subscriptions/${encodeURIComponent(id)}`,
      schema: emptySchema,
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Pfad für Logs: IDs maskieren (keine fremden Kennungen in Logs). */
export function maskPath(path: string): string {
  return path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id');
}
