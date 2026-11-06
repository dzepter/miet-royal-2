'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import {
  CONTACT_FIELD_LABELS,
  CUSTOMER_MATCH_LABELS,
  type WebsiteContactSnapshot,
  type WebsiteSubmission,
} from '../lib/cms';
import { formatBerlin } from '../lib/handover';

/**
 * Phase 16 (STAFF, Design §3.4/§11.2.12, Order §15–§17): kompakter Kasten „Website-Anfrage“
 * in der Inquiry-Ansicht. Quelle `GET /staff/processes/:id/website-submission` (gleiches
 * Recht wie die Anfrage); 404 ⇒ kein Kasten. Zeigt die abgesendeten Kontaktangaben
 * (unveränderlicher Snapshot), Abweichungen zum Kundenstamm, Dublettenhinweis und den
 * Datenschutz-Nachweis. Keine automatische Zusammenführung, keine Stammdatenänderung.
 */

function contactLines(snapshot: WebsiteContactSnapshot): Array<[string, string]> {
  const lines: Array<[string, string]> =
    snapshot.type === 'private'
      ? [
          ['Kundenart', 'Privatperson'],
          ['Name', `${snapshot.firstName} ${snapshot.lastName}`],
        ]
      : [
          ['Kundenart', 'Organisation / Firma / Verein'],
          ['Organisation', snapshot.organizationName],
          ['Ansprechpartner', snapshot.contactPerson],
        ];
  lines.push(['E-Mail', snapshot.email]);
  lines.push(['Telefon', snapshot.phone ?? '–']);
  return lines;
}

export function WebsiteSubmissionBox({
  processId,
  deliveryWindowRequested,
}: {
  processId: string;
  /** Lieferung mit Wunsch-Zeitfenster ⇒ Hinweis „Uhrzeit am Veranstaltungstag“. */
  deliveryWindowRequested: boolean;
}) {
  const [submission, setSubmission] = useState<WebsiteSubmission | null>(null);

  useEffect(() => {
    let cancelled = false;
    void apiFetch<WebsiteSubmission>(`/staff/processes/${processId}/website-submission`).then(
      (result) => {
        // 404 = keine Website-Anfrage; andere Fehler (Recht, offline) ⇒ ebenfalls kein Kasten.
        if (!cancelled) setSubmission(result.ok ? result.data : null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [processId]);

  if (submission === null) return null;
  const differences = submission.differences.map((field) => CONTACT_FIELD_LABELS[field] ?? field);

  return (
    <section className="card" data-testid="website-submission">
      <h2>Website-Anfrage</h2>
      <p className="muted">
        Über die Website eingegangen am {formatBerlin(submission.submittedAt)} – unverbindliche
        Anfrage, keine Buchung.
      </p>
      <p data-testid="website-submission-match">
        {CUSTOMER_MATCH_LABELS[submission.customerMatch]}
      </p>
      {submission.duplicateWarning && (
        <p className="conflict-box" role="status" data-testid="website-submission-duplicate">
          Mögliche Dublette: Mehrere bestehende Kunden haben diese E-Mail-Adresse. Es wurde nichts
          zusammengeführt – bitte bei Bedarf im Kundenstamm prüfen.
        </p>
      )}
      <h3 style={{ fontSize: '0.95rem', marginBottom: '0.25rem' }}>Abgesendete Kontaktangaben</h3>
      <dl style={{ margin: '0 0 0.5rem' }}>
        {contactLines(submission.contactSnapshot).map(([term, value]) => (
          <div key={term} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <dt className="muted" style={{ minWidth: '8rem' }}>
              {term}
            </dt>
            <dd style={{ margin: 0 }}>{value}</dd>
          </div>
        ))}
      </dl>
      {differences.length > 0 ? (
        <p className="conflict-box" data-testid="website-submission-differences">
          Abweichend vom aktuellen Kundenstamm: {differences.join(', ')}. Der Kundenstamm wurde
          nicht automatisch geändert.
        </p>
      ) : (
        <p className="muted" data-testid="website-submission-differences">
          Die Kontaktangaben stimmen mit dem Kundenstamm überein.
        </p>
      )}
      {deliveryWindowRequested && (
        <p className="muted" data-testid="website-submission-window">
          Das Wunsch-Lieferzeitfenster wurde auf der Website als Uhrzeit am Veranstaltungstag
          angegeben.
        </p>
      )}
      <p className="muted" data-testid="website-submission-privacy">
        Datenschutzhinweise zur Kenntnis genommen am{' '}
        {formatBerlin(submission.privacy.acknowledgedAt)} (veröffentlichte Fassung: Revision{' '}
        {submission.privacy.revisionNumber}).
      </p>
    </section>
  );
}
