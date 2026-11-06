'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CONFIGURATOR_STEPS,
  CONFIGURATOR_TEXT,
  MAX_GUESTS,
  PREVIEW_DEBOUNCE_MS,
  buildInquiryPayload,
  buildPreviewRequest,
  clearStoredMutationId,
  createClientMutationId,
  createInitialState,
  endsNextDay,
  ensureMutationId,
  fetchConfiguratorPreview,
  firstInvalidStep,
  inquiryOutcomeMessage,
  isLargeEvent,
  isRetryableOutcome,
  nextStep,
  previousStep,
  stepIndex,
  submitInquiry,
  totalLiters,
  validateStep,
  type ConfiguratorField,
  type ConfiguratorState,
  type ConfiguratorStepId,
  type FieldErrors,
  type InquiryOutcome,
  type StorageLike,
  type ValidationContext,
} from '../../lib/configurator';
import { formatDate } from '../../lib/portal';
import {
  formatNumber,
  formatPriceCents,
  machineCapacityText,
  productPriceText,
  quantityText,
} from '../../lib/site-format';
import { PRIVACY_PATH } from '../../lib/site-nav';
import type {
  PublicCatalog,
  PublicConfiguratorPreview,
  PublicInquiryRequest,
  PublicProduct,
} from '../../lib/site-types';
import site from '../site/site.module.css';
import styles from './configurator.module.css';

/**
 * Phase 16 (WEB, Order §11–§17, Design §5/§11.2.7/§11.2.8): Slush-Konfigurator in 6 Schritten.
 *
 * - Laufende Übersicht ausschließlich aus `POST /api/public/configurator/preview` (entprellt);
 *   der Browser rechnet nie Geld, Empfehlung/Kontingente/Hinweise kommen vom Server.
 * - Absenden: `clientMutationId` aus sessionStorage (nur die ID), Doppelklick-Sperre; unklarer
 *   Ausgang ⇒ Formular gesperrt, „Erneut senden“ mit IDENTISCHEM Payload; 409 mit Vorgangsnummer
 *   ⇒ „bereits eingegangen“; ohne veröffentlichte Datenschutzhinweise kein Absenden.
 * - Keine verbindliche Buchung, kein Online-Payment, keine Verfügbarkeitsanzeige.
 */

export interface ConfiguratorProps {
  catalog: PublicCatalog;
  /** Datenschutzhinweise veröffentlicht (Order §17) – sonst Absenden fail-closed gesperrt. */
  privacyPublished: boolean;
  /** Build-/Laufzeit-Origin weichen ab (Design §11.2.10) ⇒ Absenden gesperrt. */
  submitDisabled: boolean;
  /** Heutiges Datum Europe/Berlin (vom Server, `YYYY-MM-DD`). */
  today: string;
  /** Vorauswahl aus `?maschine=` (nur wenn im Katalog). */
  initialMachineSlug: string;
}

type PreviewStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'rate_limited';

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'failed'; outcome: InquiryOutcome }
  | { kind: 'done'; processNumber: string | null; alreadyReceived: boolean };

const CUPS_SLUG = 'becher-25';
const STRAWS_SLUG = 'strohhalme-25';

function sessionStore(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function fieldId(field: ConfiguratorField): string {
  return `cfg-${field}`;
}

function errorId(field: ConfiguratorField): string {
  return `cfg-${field}-error`;
}

function describedBy(...ids: Array<string | false | null | undefined>): string | undefined {
  const list = ids.filter((id): id is string => typeof id === 'string' && id !== '');
  return list.length === 0 ? undefined : list.join(' ');
}

function FieldError({ field, errors }: { field: ConfiguratorField; errors: FieldErrors }) {
  const message = errors[field];
  if (message === undefined) return null;
  return (
    <span id={errorId(field)} className={styles.error}>
      {message}
    </span>
  );
}

function Stepper({
  id,
  label,
  meta,
  value,
  max,
  disabled,
  onChange,
  unit,
  testId,
}: {
  id: string;
  label: string;
  meta?: ReactNode;
  value: number;
  max: number;
  disabled?: boolean | undefined;
  onChange: (value: number) => void;
  unit: string;
  testId: string;
}) {
  const clamp = (next: number) => Math.max(0, Math.min(max, Math.floor(next)));
  return (
    <div className={styles.stepperRow}>
      <div className={styles.stepperLabel}>
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
        {meta ? <span className={styles.hint}>{meta}</span> : null}
      </div>
      <div className={styles.stepperControls}>
        <button
          type="button"
          className={styles.stepperButton}
          onClick={() => onChange(clamp(value - 1))}
          disabled={disabled === true || value <= 0}
          aria-label={`${label}: eins weniger`}
          data-testid={`${testId}-minus`}
        >
          −
        </button>
        <input
          id={id}
          className={styles.stepperValue}
          type="number"
          inputMode="numeric"
          min={0}
          max={max}
          step={1}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10);
            onChange(Number.isNaN(parsed) ? 0 : clamp(parsed));
          }}
          aria-describedby={`${id}-unit`}
          data-testid={testId}
        />
        <span id={`${id}-unit`} className={styles.hint}>
          {unit}
        </span>
        <button
          type="button"
          className={styles.stepperButton}
          onClick={() => onChange(clamp(value + 1))}
          disabled={disabled === true || value >= max}
          aria-label={`${label}: eins mehr`}
          data-testid={`${testId}-plus`}
        >
          +
        </button>
      </div>
    </div>
  );
}

function syrupFlavor(product: PublicProduct): string {
  return product.name.replace(/^Sirup\s+/i, '');
}

export function Configurator({
  catalog,
  privacyPublished,
  submitDisabled,
  today,
  initialMachineSlug,
}: ConfiguratorProps) {
  const [state, setState] = useState<ConfiguratorState>(() =>
    createInitialState(initialMachineSlug),
  );
  const [step, setStep] = useState<ConfiguratorStepId>('event');
  const [visited, setVisited] = useState(0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [preview, setPreview] = useState<PublicConfiguratorPreview | null>(null);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>('idle');
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' });
  const [privacyBlocked, setPrivacyBlocked] = useState(!privacyPublished);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const confirmationRef = useRef<HTMLHeadingElement>(null);
  const lastFocusedStep = useRef<ConfiguratorStepId>('event');
  const sendingRef = useRef(false);
  const mutationIdRef = useRef<string | null>(null);
  const pendingPayloadRef = useRef<PublicInquiryRequest | null>(null);

  const machineSlugs = useMemo(
    () => new Set(catalog.machines.map((machine) => machine.slug)),
    [catalog.machines],
  );
  const occasionValues = useMemo(
    () => new Set(catalog.occasions.map((occasion) => occasion.value)),
    [catalog.occasions],
  );
  const validation: ValidationContext = {
    today,
    machineSlugs,
    occasions: occasionValues,
    quota: preview?.quota ?? null,
  };

  const locked =
    submit.kind === 'sending' || (submit.kind === 'failed' && isRetryableOutcome(submit.outcome));

  // ── Laufende Übersicht (serverseitig berechnet, entprellt) ────────────────
  const previewKey = JSON.stringify(buildPreviewRequest(state));
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPreviewStatus('loading');
      void fetchConfiguratorPreview(JSON.parse(previewKey), { signal: controller.signal }).then(
        (outcome) => {
          if (outcome.kind === 'aborted' || controller.signal.aborted) return;
          if (outcome.kind === 'ok') {
            setPreview(outcome.preview);
            setPreviewStatus('ready');
          } else {
            setPreviewStatus(outcome.kind === 'rate_limited' ? 'rate_limited' : 'unavailable');
          }
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [previewKey]);

  // Fokus auf die Schrittüberschrift nach jedem Schrittwechsel (nicht beim ersten Rendern;
  // Vergleich mit dem zuletzt fokussierten Schritt – robust gegen doppelte Effekte im StrictMode).
  useEffect(() => {
    if (lastFocusedStep.current === step) return;
    lastFocusedStep.current = step;
    headingRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (submit.kind === 'done') confirmationRef.current?.focus();
  }, [submit.kind]);

  function update(mutator: (draft: ConfiguratorState) => ConfiguratorState) {
    if (locked) return;
    setState((current) => mutator(current));
  }

  function goTo(target: ConfiguratorStepId) {
    if (locked) return;
    setErrors({});
    // Ein abgeschlossener (nicht wiederholbarer) Fehlversuch gilt nach dem Weiterblättern als gelesen.
    if (submit.kind === 'failed') setSubmit({ kind: 'idle' });
    setStep(target);
    setVisited((current) => Math.max(current, stepIndex(target)));
  }

  function showErrors(found: FieldErrors) {
    setErrors(found);
    // Nach dem Rendern der Fehlerliste dorthin springen (Screenreader liest role=alert vor).
    requestAnimationFrame(() => errorSummaryRef.current?.focus());
  }

  function handleNext(event: React.FormEvent) {
    event.preventDefault();
    const found = validateStep(step, state, validation);
    if (Object.keys(found).length > 0) {
      showErrors(found);
      return;
    }
    goTo(nextStep(step));
  }

  async function send(payload: PublicInquiryRequest) {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSubmit({ kind: 'sending' });
    const outcome = await submitInquiry(payload);
    sendingRef.current = false;
    if (outcome.kind === 'success' || outcome.kind === 'already_received') {
      clearStoredMutationId(sessionStore());
      mutationIdRef.current = null;
      pendingPayloadRef.current = null;
      setSubmit({
        kind: 'done',
        processNumber: outcome.processNumber,
        alreadyReceived: outcome.kind === 'already_received',
      });
      return;
    }
    if (outcome.kind === 'privacy_unavailable') setPrivacyBlocked(true);
    if (outcome.kind === 'invalid') {
      // Abgelehnte Eingaben: Payload verwerfen (nichts wurde gespeichert), zum Schritt springen.
      pendingPayloadRef.current = null;
      const first = outcome.issues[0];
      if (first !== undefined) {
        setStep(first.step);
        setVisited((current) => Math.max(current, stepIndex(first.step)));
      }
    } else if (!isRetryableOutcome(outcome)) {
      pendingPayloadRef.current = null;
    }
    setSubmit({ kind: 'failed', outcome });
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (sendingRef.current || locked || privacyBlocked || submitDisabled) return;
    const invalidStep = firstInvalidStep(state, validation);
    if (invalidStep !== null) {
      if (invalidStep !== 'summary') goTo(invalidStep);
      showErrors(validateStep(invalidStep, state, validation));
      return;
    }
    mutationIdRef.current ??= ensureMutationId(sessionStore(), () => createClientMutationId());
    const payload = buildInquiryPayload(state, mutationIdRef.current);
    pendingPayloadRef.current = payload;
    void send(payload);
  }

  function retry() {
    const payload = pendingPayloadRef.current;
    if (payload === null) return;
    void send(payload);
  }

  function restart() {
    setState(createInitialState());
    setStep('event');
    setVisited(0);
    setErrors({});
    setSubmit({ kind: 'idle' });
  }

  if (submit.kind === 'done') {
    return (
      <Confirmation
        processNumber={submit.processNumber}
        alreadyReceived={submit.alreadyReceived}
        headingRef={confirmationRef}
        onRestart={restart}
      />
    );
  }

  const currentIndex = stepIndex(step);
  const currentStep = CONFIGURATOR_STEPS[currentIndex]!;
  const errorEntries = Object.entries(errors) as Array<[ConfiguratorField, string]>;
  const largeEvent = isLargeEvent(state.event.guests, catalog.largeEventGuestThreshold);

  return (
    <div className={styles.layout} data-testid="configurator">
      <div>
        <nav aria-label="Schritte des Konfigurators">
          <ol className={styles.progress}>
            {CONFIGURATOR_STEPS.map((candidate, index) => {
              const progressClass =
                index === currentIndex
                  ? styles.progressCurrent
                  : index <= visited
                    ? styles.progressDone
                    : '';
              const reachable = index <= visited && index !== currentIndex && !locked;
              return (
                <li key={candidate.id} className={styles.progressItem}>
                  <button
                    type="button"
                    className={`${styles.progressButton} ${progressClass}`}
                    aria-current={index === currentIndex ? 'step' : undefined}
                    disabled={!reachable}
                    onClick={() => goTo(candidate.id)}
                    aria-label={`Schritt ${index + 1}: ${candidate.title}`}
                    data-testid={`cfg-progress-${candidate.id}`}
                  >
                    <span className={styles.progressLabel}>{candidate.title}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <form
          className={styles.panel}
          onSubmit={step === 'summary' ? handleSubmit : handleNext}
          noValidate
          data-testid={`cfg-step-${step}`}
        >
          <p className={site.eyebrow}>
            Schritt {currentIndex + 1} von {CONFIGURATOR_STEPS.length}
          </p>
          <h2 ref={headingRef} tabIndex={-1} className={styles.stepTitle}>
            {currentStep.title}
          </h2>

          {errorEntries.length > 0 ? (
            <div
              ref={errorSummaryRef}
              tabIndex={-1}
              role="alert"
              className={`${site.noticeError} ${styles.errorSummary}`}
              data-testid="cfg-errors"
            >
              <p>Bitte prüfe folgende Angaben:</p>
              <ul>
                {errorEntries.map(([field, message]) => (
                  <li key={field}>
                    <a href={`#${fieldId(field)}`}>{message}</a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <fieldset className={styles.fieldset} disabled={locked}>
            {step === 'event' ? (
              <EventStep
                state={state}
                errors={errors}
                catalog={catalog}
                today={today}
                largeEvent={largeEvent}
                update={update}
              />
            ) : null}
            {step === 'machine' ? (
              <MachineStep
                state={state}
                errors={errors}
                catalog={catalog}
                preview={preview}
                update={update}
              />
            ) : null}
            {step === 'syrup' ? (
              <SyrupStep
                state={state}
                errors={errors}
                catalog={catalog}
                preview={preview}
                update={update}
              />
            ) : null}
            {step === 'fulfillment' ? (
              <FulfillmentStep state={state} errors={errors} catalog={catalog} update={update} />
            ) : null}
            {step === 'contact' ? (
              <ContactStep state={state} errors={errors} update={update} />
            ) : null}
            {step === 'summary' ? (
              <SummaryStep
                state={state}
                errors={errors}
                catalog={catalog}
                largeEvent={largeEvent}
                privacyBlocked={privacyBlocked}
                submitDisabled={submitDisabled}
                onEdit={goTo}
                update={update}
              />
            ) : null}
          </fieldset>

          {submit.kind === 'failed' ? (
            <SubmitFailure
              outcome={submit.outcome}
              canRetry={isRetryableOutcome(submit.outcome) && pendingPayloadRef.current !== null}
              onRetry={retry}
            />
          ) : null}

          <div className={styles.actions}>
            {currentIndex > 0 ? (
              <button
                type="button"
                className={site.buttonSecondary}
                onClick={() => goTo(previousStep(step))}
                disabled={locked}
                data-testid="cfg-back"
              >
                Zurück
              </button>
            ) : null}
            {step === 'summary' ? (
              <button
                type="submit"
                className={site.button}
                disabled={submit.kind === 'sending' || locked || privacyBlocked || submitDisabled}
                aria-busy={submit.kind === 'sending'}
                data-testid="cfg-submit"
              >
                {submit.kind === 'sending'
                  ? CONFIGURATOR_TEXT.SUBMITTING
                  : CONFIGURATOR_TEXT.SUBMIT}
              </button>
            ) : (
              <button type="submit" className={site.button} data-testid="cfg-next">
                Weiter
              </button>
            )}
          </div>
        </form>
      </div>

      <aside className={styles.aside} aria-label="Deine Übersicht">
        <Overview catalog={catalog} preview={preview} status={previewStatus} />
      </aside>
    </div>
  );
}

// ── Schritte ─────────────────────────────────────────────────────────────────

type Update = (mutator: (draft: ConfiguratorState) => ConfiguratorState) => void;

function EventStep({
  state,
  errors,
  catalog,
  today,
  largeEvent,
  update,
}: {
  state: ConfiguratorState;
  errors: FieldErrors;
  catalog: PublicCatalog;
  today: string;
  largeEvent: boolean;
  update: Update;
}) {
  const setEvent = (patch: Partial<ConfiguratorState['event']>) =>
    update((draft) => ({ ...draft, event: { ...draft.event, ...patch } }));
  return (
    <>
      <p className={styles.stepIntro}>
        Erzähl uns kurz von deinem Event – Start und Ende kannst du auch später noch abstimmen.
      </p>
      <div className={styles.field}>
        <label htmlFor={fieldId('date')} className={styles.label}>
          Datum
        </label>
        <input
          id={fieldId('date')}
          className={styles.input}
          type="date"
          min={today}
          value={state.event.date}
          onChange={(event) => setEvent({ date: event.target.value })}
          aria-invalid={errors.date !== undefined}
          aria-describedby={describedBy(errors.date !== undefined && errorId('date'))}
          required
          data-testid="cfg-date"
        />
        <FieldError field="date" errors={errors} />
      </div>
      <div className={styles.grid2}>
        <div className={styles.field}>
          <label htmlFor={fieldId('startTime')} className={styles.label}>
            Beginn <span className={styles.optional}>(optional)</span>
          </label>
          <input
            id={fieldId('startTime')}
            className={styles.input}
            type="time"
            value={state.event.startTime}
            onChange={(event) => setEvent({ startTime: event.target.value })}
            aria-invalid={errors.startTime !== undefined}
            aria-describedby={describedBy(errors.startTime !== undefined && errorId('startTime'))}
            data-testid="cfg-start-time"
          />
          <FieldError field="startTime" errors={errors} />
        </div>
        <div className={styles.field}>
          <label htmlFor={fieldId('endTime')} className={styles.label}>
            Ende <span className={styles.optional}>(optional)</span>
          </label>
          <input
            id={fieldId('endTime')}
            className={styles.input}
            type="time"
            value={state.event.endTime}
            onChange={(event) => setEvent({ endTime: event.target.value })}
            aria-invalid={errors.endTime !== undefined}
            aria-describedby={describedBy(
              errors.endTime !== undefined && errorId('endTime'),
              endsNextDay(state.event) && 'cfg-end-next-day',
            )}
            data-testid="cfg-end-time"
          />
          <FieldError field="endTime" errors={errors} />
          {endsNextDay(state.event) ? (
            <span id="cfg-end-next-day" className={styles.hint}>
              Das Ende liegt vor dem Beginn – wir verstehen das als Ende am Folgetag.
            </span>
          ) : null}
        </div>
      </div>
      <div className={styles.grid2}>
        <div className={styles.field}>
          <label htmlFor={fieldId('guests')} className={styles.label}>
            Ungefähre Gästezahl
          </label>
          <input
            id={fieldId('guests')}
            className={styles.input}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_GUESTS}
            step={1}
            value={state.event.guests}
            onChange={(event) => setEvent({ guests: event.target.value })}
            aria-invalid={errors.guests !== undefined}
            aria-describedby={describedBy(
              errors.guests !== undefined && errorId('guests'),
              largeEvent && 'cfg-large-event',
            )}
            required
            data-testid="cfg-guests"
          />
          <FieldError field="guests" errors={errors} />
        </div>
        <div className={styles.field}>
          <label htmlFor={fieldId('occasion')} className={styles.label}>
            Anlass
          </label>
          <select
            id={fieldId('occasion')}
            className={styles.select}
            value={state.event.occasion}
            onChange={(event) => setEvent({ occasion: event.target.value })}
            aria-invalid={errors.occasion !== undefined}
            aria-describedby={describedBy(errors.occasion !== undefined && errorId('occasion'))}
            required
            data-testid="cfg-occasion"
          >
            <option value="">Bitte wählen</option>
            {catalog.occasions.map((occasion) => (
              <option key={occasion.value} value={occasion.value}>
                {occasion.label}
              </option>
            ))}
          </select>
          <FieldError field="occasion" errors={errors} />
        </div>
      </div>
      {largeEvent ? <LargeEventNotice threshold={catalog.largeEventGuestThreshold} /> : null}
    </>
  );
}

function LargeEventNotice({ threshold }: { threshold: number }) {
  return (
    <div id="cfg-large-event" className={site.notice} role="status" data-testid="cfg-large-event">
      <p>
        <strong>Großes Event – schön!</strong> Ab {threshold} Gästen stimmen wir die Details gern
        persönlich mit dir ab, damit alles passt. Du kannst deine Anfrage ganz normal absenden.
      </p>
    </div>
  );
}

function MachineStep({
  state,
  errors,
  catalog,
  preview,
  update,
}: {
  state: ConfiguratorState;
  errors: FieldErrors;
  catalog: PublicCatalog;
  preview: PublicConfiguratorPreview | null;
  update: Update;
}) {
  const recommendedSlug = preview?.recommendation.machineSlug ?? null;
  const message = preview?.recommendation.message ?? CONFIGURATOR_TEXT.RECOMMENDATION_FALLBACK;
  return (
    <>
      <div
        className={`${site.notice} ${styles.recommendation}`}
        role="status"
        data-testid="cfg-recommendation"
      >
        <p>{message}</p>
      </div>
      <fieldset
        className={styles.fieldset}
        aria-describedby={describedBy(errors.machineSlug !== undefined && errorId('machineSlug'))}
      >
        <legend className={styles.legend}>Wähle deine Maschine</legend>
        <p className={styles.hint}>
          Die Empfehlung ist nur ein Vorschlag – du kannst jede Maschine frei wählen.
        </p>
        <div className={styles.choiceList} id={fieldId('machineSlug')}>
          {catalog.machines.map((machine) => (
            <label
              key={machine.slug}
              className={styles.choice}
              data-testid={`cfg-machine-${machine.slug}`}
            >
              <input
                type="radio"
                name="machine"
                value={machine.slug}
                checked={state.machineSlug === machine.slug}
                onChange={() => update((draft) => ({ ...draft, machineSlug: machine.slug }))}
              />
              <span className={styles.choiceBody}>
                <span className={styles.choiceTitle}>
                  {machine.name}{' '}
                  {recommendedSlug === machine.slug ? (
                    <span className={site.badge} data-testid="cfg-recommended-badge">
                      Empfohlen
                    </span>
                  ) : null}
                </span>
                <span className={styles.choiceMeta}>{machineCapacityText(machine)}</span>
                {machine.description ? (
                  <span className={styles.choiceMeta}>{machine.description}</span>
                ) : null}
                <span className={styles.choicePrice}>{productPriceText(machine)}</span>
              </span>
            </label>
          ))}
        </div>
        <FieldError field="machineSlug" errors={errors} />
      </fieldset>
    </>
  );
}

function SyrupStep({
  state,
  errors,
  catalog,
  preview,
  update,
}: {
  state: ConfiguratorState;
  errors: FieldErrors;
  catalog: PublicCatalog;
  preview: PublicConfiguratorPreview | null;
  update: Update;
}) {
  const quota = preview?.quota ?? null;
  const freeQuota = quota?.freeSyrupLiters ?? 0;
  const assigned = totalLiters(state.freeSyrups);
  const open = Math.max(0, freeQuota - assigned);
  const cups = catalog.accessories.find((item) => item.slug === CUPS_SLUG) ?? null;
  const straws = catalog.accessories.find((item) => item.slug === STRAWS_SLUG) ?? null;
  const setFree = (slug: string, liters: number) =>
    update((draft) => ({ ...draft, freeSyrups: { ...draft.freeSyrups, [slug]: liters } }));
  const setExtra = (slug: string, liters: number) =>
    update((draft) => ({ ...draft, extraSyrups: { ...draft.extraSyrups, [slug]: liters } }));
  return (
    <>
      <div className={styles.sectionBox} id={fieldId('freeSyrups')} data-testid="cfg-free-syrup">
        <h3>Gratis-Sirup</h3>
        {quota === null ? (
          <p className={styles.hint}>Dein Gratis-Kontingent wird gerade berechnet …</p>
        ) : (
          <>
            <p className={styles.hint}>
              Inklusive: <strong>{formatNumber(freeQuota)} L Sirup</strong> (
              {formatNumber(catalog.included.freeSyrupLitersPerContainer)} L je Maschinenbehälter).
              Verteile ihn frei auf deine Lieblingssorten – was du offen lässt, stimmen wir später
              mit dir ab.
            </p>
            {catalog.syrups.map((syrup) => (
              <Stepper
                key={syrup.slug}
                id={`cfg-free-${syrup.slug}`}
                label={syrupFlavor(syrup)}
                value={state.freeSyrups[syrup.slug] ?? 0}
                max={(state.freeSyrups[syrup.slug] ?? 0) + open}
                disabled={freeQuota === 0}
                onChange={(value) => setFree(syrup.slug, value)}
                unit="L"
                testId={`cfg-free-${syrup.slug}`}
              />
            ))}
            {open > 0 ? (
              <p className={styles.hint} data-testid="cfg-free-open">
                Noch offen: {formatNumber(open)} L – {CONFIGURATOR_TEXT.UNASSIGNED_SYRUP}
              </p>
            ) : null}
          </>
        )}
        <FieldError field="freeSyrups" errors={errors} />
      </div>

      <div className={styles.sectionBox} data-testid="cfg-included">
        <h3>Automatisch dabei</h3>
        <p className={styles.hint}>
          {catalog.included.cupsPerProcess} Becher und {catalog.included.strawsPerProcess}{' '}
          Strohhalme sind inklusive – einmal je Mietvorgang.
        </p>
      </div>

      <div className={styles.sectionBox} data-testid="cfg-commission">
        <h3>Zusätzlich auf Kommission</h3>
        <p className={styles.hint}>
          Berechnet wird nur, was geöffnet wurde – ungeöffnete Ware kannst du zurückgeben.
        </p>
        {catalog.syrups.map((syrup) => (
          <Stepper
            key={syrup.slug}
            id={`cfg-extra-${syrup.slug}`}
            label={`${syrupFlavor(syrup)} (zusätzlich)`}
            meta={productPriceText(syrup)}
            value={state.extraSyrups[syrup.slug] ?? 0}
            max={50}
            onChange={(value) => setExtra(syrup.slug, value)}
            unit="L"
            testId={`cfg-extra-${syrup.slug}`}
          />
        ))}
        {cups !== null ? (
          <Stepper
            id="cfg-cups"
            label={cups.name}
            meta={productPriceText(cups)}
            value={state.cups25}
            max={50}
            onChange={(value) => update((draft) => ({ ...draft, cups25: value }))}
            unit="Pack"
            testId="cfg-cups"
          />
        ) : null}
        {straws !== null ? (
          <Stepper
            id="cfg-straws"
            label={straws.name}
            meta={productPriceText(straws)}
            value={state.straws25}
            max={50}
            onChange={(value) => update((draft) => ({ ...draft, straws25: value }))}
            unit="Pack"
            testId="cfg-straws"
          />
        ) : null}
      </div>

      {catalog.canister !== null ? (
        <div className={styles.sectionBox} id={fieldId('canisters')} data-testid="cfg-canister">
          <h3>{catalog.canister.name} – empfohlen</h3>
          {catalog.canister.description ? (
            <p className={styles.hint}>{catalog.canister.description}</p>
          ) : null}
          <Stepper
            id="cfg-canisters-input"
            label="Anzahl Mischkanister"
            meta={`${productPriceText(catalog.canister)} · höchstens ${quota?.canisterMax ?? '–'} für deine Maschine`}
            value={state.canisters}
            max={Math.max(quota?.canisterMax ?? 0, state.canisters)}
            disabled={quota === null}
            onChange={(value) => update((draft) => ({ ...draft, canisters: value }))}
            unit="Stück"
            testId="cfg-canisters"
          />
          <FieldError field="canisters" errors={errors} />
        </div>
      ) : null}

      {preview !== null && preview.issues.length > 0 ? (
        <div className={site.notice} role="status" data-testid="cfg-issues">
          {preview.issues.map((issue) => (
            <p key={issue.code}>{issue.message}</p>
          ))}
        </div>
      ) : null}
    </>
  );
}

function FulfillmentStep({
  state,
  errors,
  catalog,
  update,
}: {
  state: ConfiguratorState;
  errors: FieldErrors;
  catalog: PublicCatalog;
  update: Update;
}) {
  const setDelivery = (patch: Partial<ConfiguratorState['delivery']>) =>
    update((draft) => ({ ...draft, delivery: { ...draft.delivery, ...patch } }));
  const text = (
    field: 'street' | 'postalCode' | 'city',
    label: string,
    options: { autoComplete: string; maxLength: number; inputMode?: 'numeric' },
  ) => (
    <div className={styles.field}>
      <label htmlFor={fieldId(field)} className={styles.label}>
        {label}
      </label>
      <input
        id={fieldId(field)}
        className={styles.input}
        type="text"
        autoComplete={options.autoComplete}
        maxLength={options.maxLength}
        inputMode={options.inputMode}
        value={state.delivery[field]}
        onChange={(event) => setDelivery({ [field]: event.target.value })}
        aria-invalid={errors[field] !== undefined}
        aria-describedby={describedBy(errors[field] !== undefined && errorId(field))}
        required
        data-testid={`cfg-${field}`}
      />
      <FieldError field={field} errors={errors} />
    </div>
  );
  return (
    <>
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Wie kommt die Maschine zu dir?</legend>
        <div className={styles.choiceList}>
          <label className={styles.choice} data-testid="cfg-fulfillment-pickup">
            <input
              type="radio"
              name="fulfillment"
              value="pickup"
              checked={state.fulfillment === 'pickup'}
              onChange={() => update((draft) => ({ ...draft, fulfillment: 'pickup' }))}
            />
            <span className={styles.choiceBody}>
              <span className={styles.choiceTitle}>Selbst abholen in {catalog.pickupArea}</span>
              <span className={styles.choiceMeta}>{CONFIGURATOR_TEXT.PICKUP_ADDRESS_NOTE}</span>
            </span>
          </label>
          <label className={styles.choice} data-testid="cfg-fulfillment-delivery">
            <input
              type="radio"
              name="fulfillment"
              value="delivery"
              checked={state.fulfillment === 'delivery'}
              onChange={() => update((draft) => ({ ...draft, fulfillment: 'delivery' }))}
            />
            <span className={styles.choiceBody}>
              <span className={styles.choiceTitle}>Lieferung anfragen</span>
              <span className={styles.choiceMeta}>{CONFIGURATOR_TEXT.DELIVERY_NOTE}</span>
            </span>
          </label>
        </div>
      </fieldset>
      {state.fulfillment === 'delivery' ? (
        <fieldset className={styles.fieldset} data-testid="cfg-delivery-fields">
          <legend className={styles.legend}>Lieferadresse</legend>
          {text('street', 'Straße und Hausnummer', {
            autoComplete: 'street-address',
            maxLength: 120,
          })}
          <div className={styles.grid2}>
            {text('postalCode', 'PLZ', {
              autoComplete: 'postal-code',
              maxLength: 5,
              inputMode: 'numeric',
            })}
            {text('city', 'Ort', { autoComplete: 'address-level2', maxLength: 80 })}
          </div>
          <p className={styles.label}>{CONFIGURATOR_TEXT.DELIVERY_WINDOW_HINT}</p>
          <div className={styles.grid2}>
            <div className={styles.field}>
              <label htmlFor={fieldId('windowFrom')} className={styles.label}>
                Von <span className={styles.optional}>(optional)</span>
              </label>
              <input
                id={fieldId('windowFrom')}
                className={styles.input}
                type="time"
                value={state.delivery.windowFrom}
                onChange={(event) => setDelivery({ windowFrom: event.target.value })}
                aria-invalid={errors.windowFrom !== undefined}
                aria-describedby={describedBy(
                  errors.windowFrom !== undefined && errorId('windowFrom'),
                )}
                data-testid="cfg-window-from"
              />
              <FieldError field="windowFrom" errors={errors} />
            </div>
            <div className={styles.field}>
              <label htmlFor={fieldId('windowTo')} className={styles.label}>
                Bis <span className={styles.optional}>(optional)</span>
              </label>
              <input
                id={fieldId('windowTo')}
                className={styles.input}
                type="time"
                value={state.delivery.windowTo}
                onChange={(event) => setDelivery({ windowTo: event.target.value })}
                aria-invalid={errors.windowTo !== undefined}
                aria-describedby={describedBy(errors.windowTo !== undefined && errorId('windowTo'))}
                data-testid="cfg-window-to"
              />
              <FieldError field="windowTo" errors={errors} />
            </div>
          </div>
          <div className={site.notice} data-testid="cfg-delivery-note">
            <p>
              {CONFIGURATOR_TEXT.DELIVERY_NOTE} Den Lieferpreis bekommst du mit deinem persönlichen
              Angebot.
            </p>
          </div>
        </fieldset>
      ) : null}
    </>
  );
}

function ContactStep({
  state,
  errors,
  update,
}: {
  state: ConfiguratorState;
  errors: FieldErrors;
  update: Update;
}) {
  const setContact = (patch: Partial<ConfiguratorState['contact']>) =>
    update((draft) => ({ ...draft, contact: { ...draft.contact, ...patch } }));
  const input = (
    field: 'firstName' | 'lastName' | 'organizationName' | 'contactPerson' | 'email' | 'phone',
    label: ReactNode,
    options: { type: string; autoComplete: string; maxLength: number; required: boolean },
  ) => (
    <div className={styles.field}>
      <label htmlFor={fieldId(field)} className={styles.label}>
        {label}
      </label>
      <input
        id={fieldId(field)}
        className={styles.input}
        type={options.type}
        autoComplete={options.autoComplete}
        maxLength={options.maxLength}
        value={state.contact[field]}
        onChange={(event) => setContact({ [field]: event.target.value })}
        aria-invalid={errors[field] !== undefined}
        aria-describedby={describedBy(errors[field] !== undefined && errorId(field))}
        required={options.required}
        data-testid={`cfg-${field}`}
      />
      <FieldError field={field} errors={errors} />
    </div>
  );
  return (
    <>
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Wer fragt an?</legend>
        <div className={styles.grid2}>
          <label className={styles.choice} data-testid="cfg-contact-private">
            <input
              type="radio"
              name="contactType"
              value="private"
              checked={state.contact.type === 'private'}
              onChange={() => setContact({ type: 'private' })}
            />
            <span className={styles.choiceTitle}>Privatperson</span>
          </label>
          <label className={styles.choice} data-testid="cfg-contact-organization">
            <input
              type="radio"
              name="contactType"
              value="organization"
              checked={state.contact.type === 'organization'}
              onChange={() => setContact({ type: 'organization' })}
            />
            <span className={styles.choiceTitle}>Organisation, Firma oder Verein</span>
          </label>
        </div>
      </fieldset>
      {state.contact.type === 'private' ? (
        <div className={styles.grid2}>
          {input('firstName', 'Vorname', {
            type: 'text',
            autoComplete: 'given-name',
            maxLength: 80,
            required: true,
          })}
          {input('lastName', 'Nachname', {
            type: 'text',
            autoComplete: 'family-name',
            maxLength: 80,
            required: true,
          })}
        </div>
      ) : (
        <div className={styles.grid2}>
          {input('organizationName', 'Name der Organisation', {
            type: 'text',
            autoComplete: 'organization',
            maxLength: 160,
            required: true,
          })}
          {input('contactPerson', 'Ansprechperson', {
            type: 'text',
            autoComplete: 'name',
            maxLength: 120,
            required: true,
          })}
        </div>
      )}
      <div className={styles.grid2}>
        {input('email', 'E-Mail', {
          type: 'email',
          autoComplete: 'email',
          maxLength: 200,
          required: true,
        })}
        {input(
          'phone',
          <>
            Telefon <span className={styles.optional}>(optional)</span>
          </>,
          { type: 'tel', autoComplete: 'tel', maxLength: 40, required: false },
        )}
      </div>
    </>
  );
}

function SummaryStep({
  state,
  errors,
  catalog,
  largeEvent,
  privacyBlocked,
  submitDisabled,
  onEdit,
  update,
}: {
  state: ConfiguratorState;
  errors: FieldErrors;
  catalog: PublicCatalog;
  largeEvent: boolean;
  privacyBlocked: boolean;
  submitDisabled: boolean;
  onEdit: (step: ConfiguratorStepId) => void;
  update: Update;
}) {
  const machine = catalog.machines.find((candidate) => candidate.slug === state.machineSlug);
  const occasion = catalog.occasions.find((candidate) => candidate.value === state.event.occasion);
  const syrupName = (slug: string) => {
    const syrup = catalog.syrups.find((candidate) => candidate.slug === slug);
    return syrup === undefined ? slug : syrupFlavor(syrup);
  };
  const freeList = Object.entries(state.freeSyrups).filter(([, liters]) => liters > 0);
  const extraList = Object.entries(state.extraSyrups).filter(([, liters]) => liters > 0);
  const time =
    state.event.startTime !== '' || state.event.endTime !== ''
      ? `${state.event.startTime || '–'} bis ${state.event.endTime || '–'} Uhr${endsNextDay(state.event) ? ' (Ende am Folgetag)' : ''}`
      : 'noch offen';
  const group = (title: string, target: ConfiguratorStepId, rows: Array<[string, string]>) => (
    <div className={styles.summaryGroup} data-testid={`cfg-summary-${target}`}>
      <div className={styles.summaryHead}>
        <h3>{title}</h3>
        <button type="button" className={site.textButton} onClick={() => onEdit(target)}>
          Ändern<span className={site.visuallyHidden}> ({title})</span>
        </button>
      </div>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label} className={styles.summaryRow}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
  const contactRows: Array<[string, string]> =
    state.contact.type === 'private'
      ? [
          ['Name', `${state.contact.firstName.trim()} ${state.contact.lastName.trim()}`],
          ['E-Mail', state.contact.email.trim()],
        ]
      : [
          ['Organisation', state.contact.organizationName.trim()],
          ['Ansprechperson', state.contact.contactPerson.trim()],
          ['E-Mail', state.contact.email.trim()],
        ];
  if (state.contact.phone.trim() !== '') contactRows.push(['Telefon', state.contact.phone.trim()]);
  const fulfillmentRows: Array<[string, string]> =
    state.fulfillment === 'pickup'
      ? [['Art', `Selbst abholen in ${catalog.pickupArea}`]]
      : [
          ['Art', 'Lieferung (wird individuell geprüft)'],
          [
            'Adresse',
            `${state.delivery.street.trim()}, ${state.delivery.postalCode.trim()} ${state.delivery.city.trim()}`,
          ],
          [
            'Zeitfenster',
            state.delivery.windowFrom !== '' || state.delivery.windowTo !== ''
              ? `am Veranstaltungstag ${state.delivery.windowFrom || '–'} bis ${state.delivery.windowTo || '–'} Uhr`
              : 'noch offen',
          ],
        ];
  return (
    <>
      <p className={styles.stepIntro}>
        Bitte prüfe deine Angaben. Mit dem Absenden fragst du unverbindlich an – wir prüfen alles
        persönlich und schicken dir ein schriftliches Angebot.
      </p>
      <div className={styles.summaryList}>
        {group('Event', 'event', [
          ['Datum', formatDate(state.event.date)],
          ['Uhrzeit', time],
          ['Gäste', state.event.guests.trim()],
          ['Anlass', occasion?.label ?? '–'],
        ])}
        {group('Maschine', 'machine', [
          [
            'Maschine',
            machine === undefined ? '–' : `${machine.name} (${machineCapacityText(machine)})`,
          ],
        ])}
        {group('Sirup & Zubehör', 'syrup', [
          [
            'Gratis-Sirup',
            freeList.length === 0
              ? CONFIGURATOR_TEXT.UNASSIGNED_SYRUP
              : freeList.map(([slug, liters]) => `${syrupName(slug)} ${liters} L`).join(', '),
          ],
          [
            'Zusätzlich',
            [
              ...extraList.map(([slug, liters]) => `${syrupName(slug)} ${liters} L`),
              ...(state.cups25 > 0 ? [`${state.cups25} × 25 Becher`] : []),
              ...(state.straws25 > 0 ? [`${state.straws25} × 25 Strohhalme`] : []),
            ].join(', ') || 'nichts',
          ],
          ['Mischkanister', state.canisters > 0 ? `${state.canisters} Stück` : 'keine'],
        ])}
        {group('Abholung oder Lieferung', 'fulfillment', fulfillmentRows)}
        {group('Kontakt', 'contact', contactRows)}
      </div>
      {largeEvent ? <LargeEventNotice threshold={catalog.largeEventGuestThreshold} /> : null}

      <div className={`${styles.field} ${site.spacedTop}`}>
        <label className={styles.checkbox} data-testid="cfg-privacy-label">
          <input
            id={fieldId('privacy')}
            type="checkbox"
            checked={state.privacyAcknowledged}
            onChange={(event) =>
              update((draft) => ({ ...draft, privacyAcknowledged: event.target.checked }))
            }
            aria-invalid={errors.privacy !== undefined}
            aria-describedby={describedBy(errors.privacy !== undefined && errorId('privacy'))}
            required
            data-testid="cfg-privacy"
          />
          <span>
            {CONFIGURATOR_TEXT.PRIVACY_LABEL}{' '}
            {privacyBlocked ? null : (
              <Link href={PRIVACY_PATH} target="_blank" rel="noopener" prefetch={false}>
                Datenschutzhinweise lesen
              </Link>
            )}
          </span>
        </label>
        <FieldError field="privacy" errors={errors} />
      </div>

      {privacyBlocked ? (
        <div className={site.notice} role="status" data-testid="cfg-privacy-unavailable">
          <p>{CONFIGURATOR_TEXT.PRIVACY_UNAVAILABLE}</p>
        </div>
      ) : null}
      {submitDisabled ? (
        <div className={site.notice} role="status" data-testid="cfg-submit-disabled">
          <p>{CONFIGURATOR_TEXT.ORIGIN_MISMATCH}</p>
        </div>
      ) : null}
    </>
  );
}

function SubmitFailure({
  outcome,
  canRetry,
  onRetry,
}: {
  outcome: InquiryOutcome;
  canRetry: boolean;
  onRetry: () => void;
}) {
  const message = inquiryOutcomeMessage(outcome);
  if (message === null) return null;
  const issues = outcome.kind === 'invalid' ? outcome.issues : [];
  return (
    <div className={`${site.noticeError} ${site.spacedTop}`} role="alert" data-testid="cfg-error">
      <p>{message}</p>
      {issues.length > 0 ? (
        <ul>
          {issues.map((issue) => (
            <li key={`${issue.path}-${issue.message}`}>{issue.message}</li>
          ))}
        </ul>
      ) : null}
      {canRetry ? (
        <div className={site.buttonRow}>
          <button type="button" className={site.button} onClick={onRetry} data-testid="cfg-retry">
            {CONFIGURATOR_TEXT.RETRY}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Confirmation({
  processNumber,
  alreadyReceived,
  headingRef,
  onRestart,
}: {
  processNumber: string | null;
  alreadyReceived: boolean;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onRestart: () => void;
}) {
  return (
    <div className={styles.layout}>
      <div className={styles.confirmation} data-testid="cfg-confirmation" role="status">
        <h2 ref={headingRef} tabIndex={-1} className={site.h2}>
          {alreadyReceived
            ? CONFIGURATOR_TEXT.ALREADY_RECEIVED
            : 'Danke! Deine Anfrage ist bei uns eingegangen.'}
        </h2>
        {processNumber !== null ? (
          <>
            <p className={site.flush}>Deine Vorgangsnummer:</p>
            <p className={styles.processNumber} data-testid="cfg-process-number">
              {processNumber}
            </p>
          </>
        ) : null}
        {alreadyReceived ? (
          <p>
            Wir haben deine Anfrage schon. Wenn du etwas ändern möchtest, melde dich gern direkt bei
            uns und nenne dabei deine Vorgangsnummer.
          </p>
        ) : (
          <p>
            Deine Anfrage ist <strong>unverbindlich</strong> – das ist noch keine Buchung. Wir
            prüfen sie persönlich und melden uns mit einem schriftlichen Angebot. Verbindlich wird
            es erst, wenn du unser Angebot annimmst.
          </p>
        )}
        <div className={site.buttonRow}>
          <Link href="/" prefetch={false} className={site.buttonSecondary}>
            Zur Startseite
          </Link>
          <button type="button" className={site.textButton} onClick={onRestart}>
            Neue Anfrage starten
          </button>
        </div>
      </div>
    </div>
  );
}

function Overview({
  catalog,
  preview,
  status,
}: {
  catalog: PublicCatalog;
  preview: PublicConfiguratorPreview | null;
  status: PreviewStatus;
}) {
  const statusText =
    status === 'loading'
      ? 'Übersicht wird aktualisiert …'
      : status === 'unavailable'
        ? CONFIGURATOR_TEXT.PREVIEW_UNAVAILABLE
        : status === 'rate_limited'
          ? CONFIGURATOR_TEXT.PREVIEW_RATE_LIMITED
          : '';
  return (
    <section className={styles.overview} aria-busy={status === 'loading'} data-testid="cfg-summary">
      <h2 className={styles.overviewTitle}>Deine Übersicht</h2>
      <p className={styles.overviewStatus} aria-live="polite">
        {statusText}
      </p>
      {preview === null ? (
        <p className={styles.overviewNote}>{catalog.priceNote}</p>
      ) : (
        <>
          <div className={styles.overviewSection}>
            <h3>Miete und Kauf</h3>
            {preview.fixed.length === 0 ? (
              <p className={`${styles.hint} ${site.flush}`}>Noch keine Maschine gewählt.</p>
            ) : (
              <>
                <ul className={styles.overviewList} data-testid="cfg-fixed">
                  {preview.fixed.map((row) => (
                    <li key={row.label} className={styles.overviewRow}>
                      <span>
                        {row.quantity > 1 ? `${row.quantity} × ` : ''}
                        {row.label}
                      </span>
                      <span>{formatPriceCents(row.totalCents)}</span>
                    </li>
                  ))}
                </ul>
                <div className={styles.overviewTotal} data-testid="cfg-fixed-total">
                  <span>Summe</span>
                  <span>{formatPriceCents(preview.fixedTotalCents)}</span>
                </div>
              </>
            )}
          </div>
          {preview.included.length > 0 ? (
            <div className={styles.overviewSection}>
              <h3>Inklusive</h3>
              <ul className={styles.overviewList} data-testid="cfg-included-list">
                {preview.included.map((row) => (
                  <li key={row.label} className={styles.overviewRow}>
                    <span>{row.label}</span>
                    <span>{quantityText(row.quantity, row.unit)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {preview.commission.length > 0 ? (
            <div className={styles.overviewSection}>
              <h3>Auf Kommission</h3>
              <ul className={styles.overviewList} data-testid="cfg-commission-list">
                {preview.commission.map((row) => (
                  <li key={row.label} className={styles.overviewRow}>
                    <span>
                      {row.label}
                      <br />
                      <span className={styles.hint}>{quantityText(row.quantity, row.unit)}</span>
                    </span>
                    <span>je {formatPriceCents(row.unitPriceCents)}</span>
                  </li>
                ))}
              </ul>
              <p className={styles.overviewNote}>Berechnet wird nur, was geöffnet wurde.</p>
            </div>
          ) : null}
          {preview.delivery.requested ? (
            <div className={styles.overviewSection}>
              <h3>Lieferung</h3>
              <p className={`${styles.hint} ${site.flush}`} data-testid="cfg-delivery-text">
                {preview.delivery.text}
              </p>
            </div>
          ) : null}
          {preview.issues.length > 0 ? (
            <ul className={styles.issues} data-testid="cfg-preview-issues">
              {preview.issues.map((issue) => (
                <li key={issue.code}>{issue.message}</li>
              ))}
            </ul>
          ) : null}
          <p className={styles.overviewNote}>{preview.priceNote}</p>
        </>
      )}
    </section>
  );
}
