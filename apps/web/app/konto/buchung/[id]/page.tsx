'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  FULFILLMENT_LABELS,
  PORTAL_MESSAGES,
  PORTAL_ROUTES,
  PORTAL_UI,
  appointmentLabel,
  euro,
  formatAppointmentTime,
  formatDate,
  formatDateTime,
  formatEventTime,
  groupItems,
  isNotFound,
  isUnauthenticated,
  navigationHref,
  occasionLabel,
  portalDocumentHref,
  portalErrorMessage,
  portalFetch,
  type PortalBookingView,
  type PortalCancellationPreview,
  type PortalDocumentListResponse,
  type PortalDocumentView,
  type PortalMeView,
} from '../../../../lib/portal';
import {
  CallButton,
  DefinitionList,
  ErrorBox,
  InfoBox,
  Loading,
  PortalMain,
  StateBadge,
  card,
  dangerButton,
  mutedStyle,
  secondaryButton,
} from '../../../../components/portal-ui';
import { PortalMessages } from '../../../../components/portal-messages';
import { PortalTravelStatusBadge } from '../../../../components/portal-travel-status';
import { PortalCancelDialog } from '../../../../components/portal-cancel-dialog';

/**
 * Buchungsansicht /konto/buchung/[id] (Order §16–§24, §37–§44; Design §2/§5):
 * alles aus `PortalBookingView` (Snapshot-Daten der API, keine Neuberechnung
 * im Client). Abschnitte: Kopf/Status, Event, Maschinen & Extras, Termine,
 * Abholung oder Lieferung (+ „Unterwegs“), Preis, Rechnung, Dokumente,
 * Nachrichten, Storno, Anrufen. Fremde/unsichtbare Buchung ⇒ neutrale Meldung.
 */

type State =
  | { kind: 'loading' }
  | { kind: 'not_found' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; me: PortalMeView; booking: PortalBookingView };

type CancelState =
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'open'; preview: PortalCancellationPreview; busy: boolean; error: string | null };

export default function PortalBookingPage() {
  const params = useParams<{ id: string }>();
  const bookingId = typeof params.id === 'string' ? params.id : '';
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [documents, setDocuments] = useState<PortalDocumentView[] | null>(null);
  const [cancel, setCancel] = useState<CancelState>({ kind: 'closed' });
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [justCancelled, setJustCancelled] = useState(false);
  const [userAgent, setUserAgent] = useState('');

  const toLogin = useCallback(() => router.replace(PORTAL_ROUTES.login), [router]);

  useEffect(() => {
    setUserAgent(navigator.userAgent);
  }, []);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const base = `/bookings/${encodeURIComponent(bookingId)}`;
    try {
      const [me, booking] = await Promise.all([
        portalFetch<PortalMeView>('/me'),
        portalFetch<PortalBookingView>(base),
      ]);
      setState({ kind: 'ready', me, booking });
    } catch (caught) {
      if (isUnauthenticated(caught)) {
        toLogin();
        return;
      }
      if (isNotFound(caught)) {
        setState({ kind: 'not_found' });
        return;
      }
      setState({ kind: 'failed', message: portalErrorMessage(caught) });
      return;
    }
    try {
      const list = await portalFetch<PortalDocumentListResponse>(`${base}/documents`);
      setDocuments(Array.isArray(list?.documents) ? list.documents : []);
    } catch {
      setDocuments([]);
    }
  }, [bookingId, toLogin]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openCancelDialog() {
    if (cancel.kind !== 'closed') return;
    setCancel({ kind: 'loading' });
    setCancelError(null);
    try {
      const preview = await portalFetch<PortalCancellationPreview>(
        `/bookings/${encodeURIComponent(bookingId)}/cancellation/preview`,
      );
      setCancel({ kind: 'open', preview, busy: false, error: null });
    } catch (caught) {
      if (isUnauthenticated(caught)) {
        toLogin();
        return;
      }
      setCancel({ kind: 'closed' });
      setCancelError(portalErrorMessage(caught));
    }
  }

  async function confirmCancel() {
    if (cancel.kind !== 'open' || cancel.busy) return;
    setCancel({ ...cancel, busy: true, error: null });
    try {
      const updated = await portalFetch<PortalBookingView>(
        `/bookings/${encodeURIComponent(bookingId)}/cancellation`,
        { method: 'POST', body: { confirm: true } },
      );
      setCancel({ kind: 'closed' });
      setJustCancelled(true);
      setState((current) =>
        current.kind === 'ready' ? { kind: 'ready', me: current.me, booking: updated } : current,
      );
      window.scrollTo({ top: 0 });
    } catch (caught) {
      if (isUnauthenticated(caught)) {
        toLogin();
        return;
      }
      const message = portalErrorMessage(caught);
      // 409 (fachlich blockiert) ⇒ Dialog schließen, Blocker-Text + Anrufen anzeigen.
      if (isBlocked(caught)) {
        setCancel({ kind: 'closed' });
        setCancelError(message);
        return;
      }
      setCancel({ ...cancel, busy: false, error: message });
    }
  }

  if (state.kind === 'loading') {
    return (
      <PortalMain wide>
        <Loading text="Buchung wird geladen …" />
      </PortalMain>
    );
  }
  if (state.kind === 'not_found') {
    return (
      <PortalMain>
        <div style={card} data-testid="portal-booking-not-available">
          <h1 style={{ fontSize: '1.25rem', marginTop: 0 }}>{PORTAL_UI.BOOKING_NOT_AVAILABLE}</h1>
          <p style={{ marginBottom: '0.75rem', ...mutedStyle }}>
            Vielleicht ist sie bereits abgeschlossen oder gehört nicht zu deinem Zugang.
          </p>
          <Link href={PORTAL_ROUTES.home} prefetch={false} data-testid="portal-back-home">
            Zur Übersicht
          </Link>
        </div>
      </PortalMain>
    );
  }
  if (state.kind === 'failed') {
    return (
      <PortalMain>
        <ErrorBox message={state.message}>
          <p style={{ margin: '0.75rem 0 0' }}>
            <button type="button" onClick={() => void load()} style={secondaryButton}>
              Erneut versuchen
            </button>
          </p>
        </ErrorBox>
      </PortalMain>
    );
  }

  const { me, booking } = state;
  const phone = me.links.phoneNumber;
  const isActive = booking.portalState === 'active';
  const cancelled = booking.cancellation !== null;
  const eventTime = formatEventTime(booking.event.eventStart, booking.event.eventEnd);
  const occasion = occasionLabel(booking.event.occasion);
  const navHref =
    booking.pickup === null ? null : navigationHref(booking.pickup.navigation, userAgent);
  const groups = groupItems(booking.items);
  const hasCommission = booking.items.some((item) => item.billingMode === 'commission');

  return (
    <PortalMain wide testId="portal-booking-view">
      <p style={{ margin: '0 0 0.5rem' }}>
        <Link href={PORTAL_ROUTES.home} prefetch={false} data-testid="portal-back-home">
          ← Übersicht
        </Link>
      </p>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.5rem',
          marginBottom: '1rem',
        }}
      >
        <h1 style={{ fontSize: '1.4rem', margin: 0 }}>
          Buchung <span data-testid="portal-process-number">{booking.processNumber}</span>
        </h1>
        <StateBadge state={booking.portalState} label={booking.stateLabel} />
      </div>

      {cancelled && booking.cancellation !== null && (
        <InfoBox tone={justCancelled ? 'success' : 'warning'} testId="portal-cancelled-view">
          <strong>Buchung storniert</strong>
          <p style={{ margin: '0.4rem 0 0' }}>
            Storniert am {formatDateTime(booking.cancellation.cancelledAt)}.
          </p>
          <p style={{ margin: '0.4rem 0 0' }}>
            Stornogebühr:{' '}
            <strong data-testid="portal-cancellation-fee">
              {euro(booking.cancellation.feeCents)}
            </strong>
            {booking.cancellation.feeCents > 0 ? ` (${booking.cancellation.feePercent} %)` : ''}
          </p>
          {booking.cancellation.invoiceFollows && (
            <p style={{ margin: '0.4rem 0 0' }} data-testid="portal-invoice-follows">
              {PORTAL_UI.INVOICE_FOLLOWS}.
            </p>
          )}
          {justCancelled && (
            <p style={{ margin: '0.4rem 0 0', ...mutedStyle }}>
              Eine Bestätigung schicken wir dir per E-Mail.
            </p>
          )}
        </InfoBox>
      )}

      {cancelError !== null && (
        <ErrorBox message={cancelError} testId="portal-cancel-blocked">
          <div style={{ marginTop: '0.75rem' }}>
            <CallButton phoneNumber={phone} />
          </div>
        </ErrorBox>
      )}

      <section style={card} aria-labelledby="portal-event-title">
        <h2 id="portal-event-title" style={{ marginTop: 0, fontSize: '1.1rem' }}>
          Dein Event
        </h2>
        <DefinitionList
          rows={[
            {
              term: 'Eventdatum',
              value: (
                <strong data-testid="portal-event-date">
                  {formatDate(booking.event.eventDate)}
                </strong>
              ),
            },
            ...(eventTime === null ? [] : [{ term: 'Zeit', value: eventTime }]),
            ...(booking.event.guestCount === null
              ? []
              : [{ term: 'Gäste', value: `${booking.event.guestCount}` }]),
            ...(occasion === null ? [] : [{ term: 'Anlass', value: occasion }]),
            { term: 'Abwicklung', value: FULFILLMENT_LABELS[booking.fulfillment] },
            ...(booking.event.onsiteContactName === null
              ? []
              : [{ term: 'Kontakt vor Ort', value: booking.event.onsiteContactName }]),
          ]}
        />
      </section>

      <section style={card} aria-labelledby="portal-items-title">
        <h2 id="portal-items-title" style={{ marginTop: 0, fontSize: '1.1rem' }}>
          Maschinen &amp; Extras
        </h2>
        {groups.length === 0 ? (
          <p style={mutedStyle}>Keine Positionen hinterlegt.</p>
        ) : (
          groups.map((group) => (
            <div key={group.kind} data-testid={`portal-items-${group.kind}`}>
              <h3 style={{ fontSize: '0.95rem', margin: '0.75rem 0 0.25rem', ...mutedStyle }}>
                {group.label}
              </h3>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {group.items.map((item, index) => (
                  <li
                    key={`${group.kind}-${index}`}
                    data-testid="portal-item"
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: '1rem',
                      padding: '0.3rem 0',
                      borderBottom: '1px solid #f0f0f0',
                    }}
                  >
                    <span>
                      {item.description}
                      <span style={{ ...mutedStyle, fontSize: '0.9rem' }}>
                        {' '}
                        · {item.quantity} {item.unit ?? ''}
                      </span>
                    </span>
                    <span style={{ whiteSpace: 'nowrap' }}>
                      {item.billingMode === 'included'
                        ? 'inklusive'
                        : item.totalCents === null
                          ? '–'
                          : item.billingMode === 'commission'
                            ? `${euro(item.totalCents)}*`
                            : euro(item.totalCents)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      <section style={card} aria-labelledby="portal-appointments-title">
        <h2 id="portal-appointments-title" style={{ marginTop: 0, fontSize: '1.1rem' }}>
          Termine
        </h2>
        {booking.appointments.length === 0 ? (
          <p style={mutedStyle}>Die Termine stimmen wir noch mit dir ab.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {booking.appointments.map((appointment, index) => (
              <li
                key={`${appointment.kind}-${index}`}
                data-testid="portal-appointment"
                data-kind={appointment.kind}
                data-timing={appointment.timing}
                style={{ padding: '0.35rem 0', borderBottom: '1px solid #f0f0f0' }}
              >
                <strong>{appointmentLabel(appointment.kind, booking.fulfillment)}</strong>
                {appointment.status === 'cancelled' ? (
                  <span style={{ ...mutedStyle }}> – entfällt</span>
                ) : (
                  <>
                    {': '}
                    <span data-testid="portal-appointment-time">
                      {formatAppointmentTime(appointment)}
                    </span>
                    {appointment.status === 'completed' && (
                      <span style={{ ...mutedStyle }}> (erledigt)</span>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {booking.fulfillment === 'pickup' && (
        <section style={card} aria-labelledby="portal-pickup-title">
          <h2 id="portal-pickup-title" style={{ marginTop: 0, fontSize: '1.1rem' }}>
            Abholung
          </h2>
          {booking.pickup?.address ? (
            <>
              <p style={{ margin: '0 0 0.75rem' }} data-testid="portal-pickup-address">
                {booking.pickup.address}
              </p>
              {navHref !== null && (
                <a
                  href={navHref}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="portal-navigation"
                  style={{
                    ...secondaryButton,
                    display: 'block',
                    textAlign: 'center',
                    textDecoration: 'none',
                    boxSizing: 'border-box',
                  }}
                >
                  <span aria-hidden="true">➤ </span>Navigation öffnen
                </a>
              )}
            </>
          ) : (
            <p style={{ margin: 0 }} data-testid="portal-pickup-address">
              {PORTAL_UI.PICKUP_ADDRESS_PENDING}
            </p>
          )}
        </section>
      )}

      {booking.fulfillment === 'delivery' && (
        <section style={card} aria-labelledby="portal-delivery-title">
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <h2 id="portal-delivery-title" style={{ margin: 0, fontSize: '1.1rem' }}>
              Lieferung
            </h2>
            <PortalTravelStatusBadge
              bookingId={booking.bookingId}
              initialStatus={booking.travelStatus}
              poll={isActive}
            />
          </div>
          {booking.delivery !== null ? (
            <p style={{ margin: '0.75rem 0 0' }} data-testid="portal-delivery-address">
              {booking.delivery.street}
              <br />
              {booking.delivery.postalCode} {booking.delivery.city}
            </p>
          ) : (
            <p style={{ margin: '0.75rem 0 0', ...mutedStyle }}>Lieferadresse wie vereinbart.</p>
          )}
        </section>
      )}

      <section style={card} aria-labelledby="portal-price-title">
        <h2 id="portal-price-title" style={{ marginTop: 0, fontSize: '1.1rem' }}>
          Preis
        </h2>
        <DefinitionList
          rows={[
            { term: 'Maschinenmiete', value: euro(booking.price.machineSubtotalCents) },
            ...(booking.price.discountCents > 0
              ? [{ term: 'Rabatt', value: `-${euro(booking.price.discountCents)}` }]
              : []),
            ...(booking.price.voucherDiscountCents > 0
              ? [{ term: 'Gutschein', value: `-${euro(booking.price.voucherDiscountCents)}` }]
              : []),
            ...(booking.price.deliveryPriceCents === null
              ? []
              : [{ term: 'Lieferung', value: euro(booking.price.deliveryPriceCents) }]),
          ]}
        />
        <p
          style={{
            fontSize: '1.15rem',
            fontWeight: 700,
            margin: '0.75rem 0 0',
            textAlign: 'right',
          }}
        >
          Vereinbarter Preis:{' '}
          <span data-testid="portal-agreed-price">{euro(booking.price.agreedTotalCents)}</span>
        </p>
        {hasCommission && (
          <p style={{ ...mutedStyle, fontSize: '0.85rem', margin: '0.5rem 0 0' }}>
            * Kommissionsartikel – Abrechnung nach tatsächlichem Verbrauch nach der Rückgabe.
          </p>
        )}
      </section>

      {booking.invoice.status !== 'none' && (
        <section style={card} aria-labelledby="portal-invoice-title">
          <h2 id="portal-invoice-title" style={{ marginTop: 0, fontSize: '1.1rem' }}>
            Rechnung
          </h2>
          <p style={{ margin: 0 }}>
            Status:{' '}
            <strong data-testid="portal-invoice-status" data-status={booking.invoice.status}>
              {booking.invoice.label}
            </strong>
          </p>
          {booking.invoice.finalAmountCents !== null && (
            <p style={{ margin: '0.4rem 0 0' }}>
              Rechnungsbetrag:{' '}
              <strong data-testid="portal-invoice-amount">
                {euro(booking.invoice.finalAmountCents)}
              </strong>
            </p>
          )}
        </section>
      )}

      <section style={card} aria-labelledby="portal-documents-title" data-testid="portal-documents">
        <h2 id="portal-documents-title" style={{ marginTop: 0, fontSize: '1.1rem' }}>
          Dokumente
        </h2>
        {documents === null ? (
          <p style={mutedStyle}>Dokumente werden geladen …</p>
        ) : documents.length === 0 ? (
          <p style={mutedStyle} data-testid="portal-documents-empty">
            Noch keine Dokumente vorhanden.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {documents.map((document) => (
              <li
                key={document.id}
                style={{ padding: '0.35rem 0', borderBottom: '1px solid #f0f0f0' }}
                data-testid="portal-document-item"
                data-type={document.type}
              >
                <a
                  href={portalDocumentHref(booking.bookingId, document.id)}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="portal-document-link"
                  style={{ fontWeight: 600 }}
                >
                  {document.label} (PDF)
                </a>
                <span style={{ ...mutedStyle, fontSize: '0.9rem' }}>
                  {' '}
                  · {formatDate(document.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <PortalMessages bookingId={booking.bookingId} onUnauthenticated={toLogin} />

      {isActive && !cancelled && (
        <section
          style={card}
          aria-labelledby="portal-cancel-title-section"
          data-testid="portal-cancel-section"
        >
          <h2 id="portal-cancel-title-section" style={{ marginTop: 0, fontSize: '1.1rem' }}>
            Buchung stornieren
          </h2>
          {booking.canCancelOnline ? (
            <>
              <p style={{ ...mutedStyle, marginTop: 0 }}>
                Vor der Stornierung zeigen wir dir die mögliche Stornogebühr an. Erst mit der
                Bestätigung wird die Buchung verbindlich storniert.
              </p>
              <button
                type="button"
                onClick={() => void openCancelDialog()}
                disabled={cancel.kind !== 'closed'}
                style={{
                  ...dangerButton(cancel.kind === 'loading'),
                  background: '#ffffff',
                  color: '#b3261e',
                  border: '1px solid #b3261e',
                }}
                data-testid="portal-cancel-open"
              >
                {cancel.kind === 'loading' ? 'Wird geprüft …' : 'Buchung stornieren'}
              </button>
            </>
          ) : (
            <>
              <p style={{ marginTop: 0 }} data-testid="portal-cancel-unavailable">
                {PORTAL_MESSAGES.CANCELLATION_BLOCKED}
              </p>
              <CallButton phoneNumber={phone} />
            </>
          )}
        </section>
      )}

      {phone !== null && (
        <section style={card} aria-labelledby="portal-contact-title">
          <h2 id="portal-contact-title" style={{ marginTop: 0, fontSize: '1.1rem' }}>
            Fragen zu deiner Buchung?
          </h2>
          <CallButton phoneNumber={phone} />
        </section>
      )}

      {cancel.kind === 'open' && (
        <PortalCancelDialog
          preview={cancel.preview}
          busy={cancel.busy}
          error={cancel.error}
          phoneNumber={phone}
          onConfirm={() => void confirmCancel()}
          onClose={() => setCancel({ kind: 'closed' })}
        />
      )}
    </PortalMain>
  );
}

function isBlocked(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: unknown }).status === 409
  );
}
