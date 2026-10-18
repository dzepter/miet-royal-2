/**
 * Phase 12 (inbound/conversation/whatsapp): Test-Hilfen – Fixtures laden,
 * Kommunikationstabellen leeren, Kunde + Vorgang anlegen, Webhook senden.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mailDeliveries } from '@mietroyal/database';
import type pg from 'pg';
import { signWhatsAppBody } from '../src/communication/whatsapp/webhook-service.ts';
import type { TestContext } from './auth-helpers.ts';
import { adminVisibilityCtx, createTestCustomer, processServiceFor } from './crm-helpers.ts';

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'mail');

export function loadMailFixture(name: string, replacements: Record<string, string> = {}): string {
  let raw = readFileSync(join(FIXTURE_DIR, name), 'utf8');
  for (const [key, value] of Object.entries(replacements))
    raw = raw.replaceAll(`{{${key}}}`, value);
  return raw;
}

/** Kommunikationstabellen leeren (vor CRM-/Auth-Tabellen). */
export async function truncateCommunicationTables(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE message_photos, inbound_mail_receipts, inbound_mail_state, whatsapp_events,
     whatsapp_contacts, conversation_messages, mail_deliveries, integration_jobs CASCADE`,
  );
}

export async function createCustomerWithProcess(
  ctx: TestContext,
  actorId: string,
  overrides: { email?: string; phone?: string; firstName?: string; lastName?: string } = {},
) {
  const customer = await createTestCustomer(ctx, actorId, {
    firstName: overrides.firstName ?? 'Max',
    lastName: overrides.lastName ?? 'Mustermann',
    ...(overrides.email === undefined ? {} : { email: overrides.email }),
    ...(overrides.phone === undefined ? {} : { phone: overrides.phone }),
  });
  const process = await processServiceFor(ctx).createProcess(actorId, { customerId: customer.id });
  return { customer, process };
}

export async function completeProcess(ctx: TestContext, processId: string): Promise<void> {
  await processServiceFor(ctx).complete(processId, adminVisibilityCtx());
}

/** Eigene Outbox-Zeile mit bekannter Message-ID (Ziel für In-Reply-To/References). */
export async function insertOwnDelivery(
  ctx: TestContext,
  input: { processId: string; customerId: string; messageId: string; recipientEmail: string },
): Promise<string> {
  const rows = await ctx.db
    .insert(mailDeliveries)
    .values({
      kind: 'offer',
      processId: input.processId,
      customerId: input.customerId,
      recipientEmail: input.recipientEmail,
      subject: 'Ihr Angebot von Miet-Royal',
      templateKind: 'offer',
      status: 'sent',
      idempotencyKey: `test-offer:${input.messageId}`,
      messageId: input.messageId,
    })
    .returning({ id: mailDeliveries.id });
  return rows[0]!.id;
}

export function whatsappMessagePayload(input: {
  id: string;
  from: string;
  type?: 'text' | 'image' | 'document' | 'audio' | 'sticker' | 'location';
  text?: string;
  mediaId?: string;
  contextId?: string;
  profileName?: string;
  timestamp?: number;
  phoneNumberId?: string;
}): Record<string, unknown> {
  const type = input.type ?? 'text';
  const message: Record<string, unknown> = {
    from: input.from,
    id: input.id,
    timestamp: String(input.timestamp ?? Math.floor(Date.now() / 1000)),
    type,
  };
  if (type === 'text') message.text = { body: input.text ?? 'Hallo' };
  if (type === 'image')
    message.image = { id: input.mediaId ?? 'media-1', mime_type: 'image/jpeg', sha256: 'x' };
  if (type === 'document')
    message.document = { id: 'doc-1', mime_type: 'application/pdf', filename: 'x.pdf' };
  if (input.contextId !== undefined)
    message.context = { from: '100000000000001', id: input.contextId };
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '200000000000001',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '4961310000000',
                phone_number_id: input.phoneNumberId ?? '100000000000001',
              },
              contacts: [
                { profile: { name: input.profileName ?? 'Max Mustermann' }, wa_id: input.from },
              ],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

export function whatsappStatusPayload(input: {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  errorCode?: number;
}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '200000000000001',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '4961310000000',
                phone_number_id: '100000000000001',
              },
              statuses: [
                {
                  id: input.id,
                  status: input.status,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  recipient_id: '4917612345678',
                  ...(input.errorCode === undefined
                    ? {}
                    : { errors: [{ code: input.errorCode, title: 'x' }] }),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export async function postWhatsAppWebhook(
  ctx: TestContext,
  body: string | Record<string, unknown>,
  options: { signature?: string | null; secret?: string; contentType?: string } = {},
) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const secret = options.secret ?? ctx.whatsappSecrets?.appSecret ?? 'missing';
  const signature =
    options.signature === undefined
      ? signWhatsAppBody(secret, Buffer.from(raw, 'utf8'))
      : options.signature;
  return ctx.app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    payload: raw,
    headers: {
      'content-type': options.contentType ?? 'application/json',
      ...(signature === null ? {} : { 'x-hub-signature-256': signature }),
    },
  });
}

/** Alle fälligen Jobs verarbeiten (der nicht gestartete Runner stoppt `drain()` nach einem Job). */
export async function drainJobs(ctx: TestContext): Promise<number> {
  let processed = 0;
  while ((await ctx.jobs.runOnce()) !== 'idle') processed += 1;
  return processed;
}
