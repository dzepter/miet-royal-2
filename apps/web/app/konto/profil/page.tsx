'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  PORTAL_MESSAGES,
  PORTAL_ROUTES,
  PORTAL_UI,
  isReauthRequired,
  isUnauthenticated,
  portalErrorMessage,
  portalFetch,
  type PortalMessageResponse,
  type PortalProfileInput,
  type PortalProfileView,
} from '../../../lib/portal';
import {
  ErrorBox,
  InfoBox,
  Loading,
  PortalMain,
  SectionTitle,
  card,
  inputStyle,
  labelStyle,
  mutedStyle,
  primaryButton,
  secondaryButton,
} from '../../../components/portal-ui';

/**
 * Profil /konto/profil (Order §17, §31–§35; Design §1.1/§1.3/§5):
 * Formular je Kundentyp (nur bestehende Felder; `type` und `email` nicht im
 * Formular), Hinweis PROFILE_HINT. Speichern ⇒ PATCH /portal/profile.
 * 403 PORTAL_REAUTH_REQUIRED ⇒ Panel „Änderung bestätigen“ ⇒ POST
 * /portal/auth/reauth/request; der Link führt zu /konto/profil/bestaetigen.
 * E-Mail-Änderung: eigener Flow (POST /portal/auth/email-change/request).
 */

type FieldKey =
  | 'firstName'
  | 'lastName'
  | 'organizationName'
  | 'contactPerson'
  | 'phone'
  | 'billingStreet'
  | 'billingPostalCode'
  | 'billingCity'
  | 'billingCountry'
  | 'vatId'
  | 'department'
  | 'costCenter'
  | 'orderReference';

interface FieldDef {
  key: FieldKey;
  label: string;
  maxLength: number;
  autoComplete?: string;
  type?: 'text' | 'tel';
  required?: boolean;
}

const BILLING_FIELDS: FieldDef[] = [
  {
    key: 'billingStreet',
    label: 'Straße und Hausnummer',
    maxLength: 200,
    autoComplete: 'street-address',
  },
  { key: 'billingPostalCode', label: 'Postleitzahl', maxLength: 20, autoComplete: 'postal-code' },
  { key: 'billingCity', label: 'Ort', maxLength: 100, autoComplete: 'address-level2' },
  { key: 'billingCountry', label: 'Land', maxLength: 100, autoComplete: 'country-name' },
];

const PRIVATE_FIELDS: FieldDef[] = [
  {
    key: 'firstName',
    label: 'Vorname',
    maxLength: 100,
    autoComplete: 'given-name',
    required: true,
  },
  {
    key: 'lastName',
    label: 'Nachname',
    maxLength: 100,
    autoComplete: 'family-name',
    required: true,
  },
  { key: 'phone', label: 'Telefon', maxLength: 50, autoComplete: 'tel', type: 'tel' },
  ...BILLING_FIELDS,
];

const ORGANIZATION_FIELDS: FieldDef[] = [
  {
    key: 'organizationName',
    label: 'Organisation',
    maxLength: 200,
    autoComplete: 'organization',
    required: true,
  },
  { key: 'contactPerson', label: 'Ansprechpartner', maxLength: 200, autoComplete: 'name' },
  { key: 'phone', label: 'Telefon', maxLength: 50, autoComplete: 'tel', type: 'tel' },
  ...BILLING_FIELDS,
  { key: 'vatId', label: 'USt-IdNr.', maxLength: 50 },
  { key: 'department', label: 'Abteilung', maxLength: 100 },
  { key: 'costCenter', label: 'Kostenstelle', maxLength: 100 },
  { key: 'orderReference', label: 'Bestellreferenz', maxLength: 100 },
];

type Values = Record<FieldKey, string>;

function valuesFrom(profile: PortalProfileView): Values {
  return {
    firstName: profile.firstName ?? '',
    lastName: profile.lastName ?? '',
    organizationName: profile.organizationName ?? '',
    contactPerson: profile.contactPerson ?? '',
    phone: profile.phone ?? '',
    billingStreet: profile.billingStreet ?? '',
    billingPostalCode: profile.billingPostalCode ?? '',
    billingCity: profile.billingCity ?? '',
    billingCountry: profile.billingCountry ?? '',
    vatId: profile.vatId ?? '',
    department: profile.department ?? '',
    costCenter: profile.costCenter ?? '',
    orderReference: profile.orderReference ?? '',
  };
}

function inputFor(type: PortalProfileView['type'], values: Values): PortalProfileInput {
  const fields = type === 'private' ? PRIVATE_FIELDS : ORGANIZATION_FIELDS;
  const body: Record<string, string> = {};
  for (const field of fields) body[field.key] = values[field.key].trim();
  return body as unknown as PortalProfileInput;
}

export default function PortalProfilePage() {
  const router = useRouter();
  const [profile, setProfile] = useState<PortalProfileView | null>(null);
  const [values, setValues] = useState<Values | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [reauthNeeded, setReauthNeeded] = useState(false);
  const [reauthSent, setReauthSent] = useState<string | null>(null);
  const [reauthError, setReauthError] = useState<string | null>(null);
  const [justConfirmed, setJustConfirmed] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailSent, setEmailSent] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  const toLogin = useCallback(() => router.replace(PORTAL_ROUTES.login), [router]);

  useEffect(() => {
    // `?bestaetigt=1` kommt von /konto/profil/bestaetigen – kein Datum, keine ID.
    const params = new URLSearchParams(window.location.search);
    if (params.get('bestaetigt') === '1') {
      setJustConfirmed(true);
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const view = await portalFetch<PortalProfileView>('/profile');
      setProfile(view);
      setValues((current) => current ?? valuesFrom(view));
    } catch (caught) {
      if (isUnauthenticated(caught)) {
        toLogin();
        return;
      }
      setLoadError(portalErrorMessage(caught));
    }
  }, [toLogin]);

  useEffect(() => {
    void load();
  }, [load]);

  function handleAuthError(caught: unknown): boolean {
    if (isUnauthenticated(caught)) {
      toLogin();
      return true;
    }
    if (isReauthRequired(caught)) {
      setReauthNeeded(true);
      return true;
    }
    return false;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || profile === null || values === null) return;
    setBusy(true);
    setSaveError(null);
    setSaved(false);
    try {
      const updated = await portalFetch<PortalProfileView>('/profile', {
        method: 'PATCH',
        body: inputFor(profile.type, values),
      });
      setProfile(updated);
      setValues(valuesFrom(updated));
      setSaved(true);
      setReauthNeeded(false);
      setJustConfirmed(false);
    } catch (caught) {
      if (!handleAuthError(caught)) setSaveError(portalErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function requestReauth() {
    if (busy) return;
    setBusy(true);
    setReauthError(null);
    try {
      const response = await portalFetch<PortalMessageResponse>('/auth/reauth/request', {
        method: 'POST',
      });
      setReauthSent(
        typeof response?.message === 'string' && response.message !== ''
          ? response.message
          : PORTAL_UI.REAUTH_SENT,
      );
    } catch (caught) {
      if (isUnauthenticated(caught)) {
        toLogin();
        return;
      }
      setReauthError(portalErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function requestEmailChange(event: React.FormEvent) {
    event.preventDefault();
    if (emailBusy) return;
    setEmailBusy(true);
    setEmailError(null);
    setEmailSent(null);
    try {
      const response = await portalFetch<PortalMessageResponse>('/auth/email-change/request', {
        method: 'POST',
        body: { email: newEmail.trim() },
      });
      setEmailSent(
        typeof response?.message === 'string' && response.message !== ''
          ? response.message
          : PORTAL_UI.EMAIL_CHANGE_SENT,
      );
      setNewEmail('');
    } catch (caught) {
      if (!handleAuthError(caught)) setEmailError(portalErrorMessage(caught));
    } finally {
      setEmailBusy(false);
    }
  }

  if (profile === null || values === null) {
    return (
      <PortalMain>
        {loadError !== null ? (
          <ErrorBox message={loadError}>
            <p style={{ margin: '0.75rem 0 0' }}>
              <button type="button" onClick={() => void load()} style={secondaryButton}>
                Erneut versuchen
              </button>
            </p>
          </ErrorBox>
        ) : (
          <Loading text="Profil wird geladen …" />
        )}
      </PortalMain>
    );
  }

  const fields = profile.type === 'private' ? PRIVATE_FIELDS : ORGANIZATION_FIELDS;

  return (
    <PortalMain testId="portal-profile">
      <h1 style={{ fontSize: '1.4rem' }}>Dein Profil</h1>
      <InfoBox tone="info" testId="portal-profile-hint">
        {profile.hint || PORTAL_MESSAGES.PROFILE_HINT}
      </InfoBox>

      {justConfirmed && !saved && (
        <InfoBox tone="success" testId="portal-reauth-done">
          {PORTAL_UI.REAUTH_DONE}
        </InfoBox>
      )}

      {reauthNeeded && (
        <div
          style={{ ...card, borderColor: '#e65100', background: '#fff3e0' }}
          data-testid="portal-reauth-panel"
          role="status"
        >
          <SectionTitle>Änderung bestätigen</SectionTitle>
          <p style={{ marginTop: 0 }}>{PORTAL_MESSAGES.REAUTH_REQUIRED}</p>
          {reauthSent !== null ? (
            <p style={{ margin: 0 }} data-testid="portal-reauth-sent">
              <span aria-hidden="true">✓ </span>
              {reauthSent} Öffne den Link und speichere deine Änderung danach erneut.
            </p>
          ) : (
            <>
              {reauthError !== null && (
                <ErrorBox message={reauthError} testId="portal-reauth-error" />
              )}
              <button
                type="button"
                onClick={() => void requestReauth()}
                disabled={busy}
                style={primaryButton(busy)}
                data-testid="portal-reauth-request"
              >
                {busy ? 'Wird gesendet …' : 'Bestätigungslink senden'}
              </button>
            </>
          )}
        </div>
      )}

      {saved && (
        <InfoBox tone="success" testId="portal-profile-saved">
          {PORTAL_UI.PROFILE_SAVED}
        </InfoBox>
      )}
      {saveError !== null && <ErrorBox message={saveError} />}

      <form style={card} onSubmit={(e) => void save(e)} data-testid="portal-profile-form">
        <SectionTitle>
          {profile.type === 'private' ? 'Deine Angaben' : 'Angaben zur Organisation'}
        </SectionTitle>
        {fields.map((field) => (
          <div key={field.key}>
            <label htmlFor={`portal-profile-${field.key}`} style={labelStyle}>
              {field.label}
            </label>
            <input
              id={`portal-profile-${field.key}`}
              data-testid={`portal-profile-${field.key}`}
              style={inputStyle}
              type={field.type ?? 'text'}
              inputMode={field.type === 'tel' ? 'tel' : undefined}
              autoComplete={field.autoComplete}
              maxLength={field.maxLength}
              required={field.required === true}
              value={values[field.key]}
              onChange={(e) => {
                const next = e.target.value;
                setValues((current) =>
                  current === null ? current : { ...current, [field.key]: next },
                );
                setSaved(false);
              }}
            />
          </div>
        ))}
        <button
          type="submit"
          disabled={busy}
          style={primaryButton(busy)}
          data-testid="portal-profile-save"
        >
          {busy ? 'Wird gespeichert …' : 'Änderungen speichern'}
        </button>
      </form>

      <form
        style={card}
        onSubmit={(e) => void requestEmailChange(e)}
        data-testid="portal-email-change-form"
      >
        <SectionTitle>E-Mail-Adresse</SectionTitle>
        <p style={{ marginTop: 0 }}>
          Aktuell: <strong data-testid="portal-profile-email">{profile.email}</strong>
        </p>
        <p style={{ ...mutedStyle, fontSize: '0.9rem' }}>
          Eine neue Adresse wird erst wirksam, wenn du den Bestätigungslink öffnest, den wir an die
          neue Adresse schicken. Danach meldest du dich mit der neuen Adresse neu an.
        </p>
        {emailSent !== null && (
          <InfoBox tone="success" testId="portal-email-change-sent">
            {emailSent}
          </InfoBox>
        )}
        {emailError !== null && (
          <ErrorBox message={emailError} testId="portal-email-change-error" />
        )}
        <label htmlFor="portal-email-change-input" style={labelStyle}>
          Neue E-Mail-Adresse
        </label>
        <input
          id="portal-email-change-input"
          data-testid="portal-email-change-input"
          style={inputStyle}
          type="email"
          inputMode="email"
          autoComplete="email"
          maxLength={320}
          required
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
        />
        <button
          type="submit"
          disabled={emailBusy}
          style={secondaryButton}
          data-testid="portal-email-change-submit"
        >
          {emailBusy ? 'Wird gesendet …' : 'E-Mail-Adresse ändern'}
        </button>
      </form>
    </PortalMain>
  );
}
