'use client';

import {
  overlappingRecommendationRules,
  type CmsImageRef,
  type CmsRecommendationRule,
  type CmsSiteSettings,
} from '@mietroyal/validation/cms';
import { useContext } from 'react';
import type { CmsCatalogMachine } from '../lib/cms';
import { CmsEditorDataContext, CmsImageField, CmsTextField, useFieldIssues } from './cms-fields';

/**
 * Phase 16 (STAFF, Design §6/Order §12): Formular der Website-Einstellungen inkl.
 * Empfehlungsregeln (Gäste von/bis ⇒ Maschine). Regeln dürfen Lücken haben, sich aber
 * nicht überschneiden; Maschinen nur aus dem Katalog (`GET /staff/cms/catalog`, aktive
 * Slush-Maschinen). Keine Formel, keine vorbelegten Bereiche – leer ist erlaubt. Der
 * Server prüft Schema, Überschneidung und aktive Maschinen erneut.
 */

export interface CmsRuleForm {
  guestMin: string;
  guestMax: string;
  machineProductSlug: string;
}

export interface CmsSettingsForm {
  businessName: string;
  tagline: string;
  phone: string;
  email: string;
  instagramUrl: string;
  logo: CmsImageRef | undefined;
  footerNote: string;
  rules: CmsRuleForm[];
}

export function settingsFormFrom(settings: CmsSiteSettings): CmsSettingsForm {
  return {
    businessName: settings.businessName,
    tagline: settings.tagline ?? '',
    phone: settings.contact.phone ?? '',
    email: settings.contact.email ?? '',
    instagramUrl: settings.instagramUrl ?? '',
    logo: settings.logo,
    footerNote: settings.footerNote ?? '',
    rules: settings.recommendationRules.map((rule) => ({
      guestMin: String(rule.guestMin),
      guestMax: rule.guestMax === undefined ? '' : String(rule.guestMax),
      machineProductSlug: rule.machineProductSlug,
    })),
  };
}

/** Ganze Zahl aus einem Eingabefeld; alles andere ⇒ NaN (das Schema meldet es verständlich). */
function wholeNumber(value: string): number {
  return /^\s*\d{1,6}\s*$/.test(value) ? Number(value) : Number.NaN;
}

/** Formular ⇒ Inhalt für `cmsSiteSettingsSchema` (leere optionale Felder entfallen). */
export function settingsContentFrom(form: CmsSettingsForm): Record<string, unknown> {
  const contact: Record<string, string> = {};
  if (form.phone.trim() !== '') contact.phone = form.phone.trim();
  if (form.email.trim() !== '') contact.email = form.email.trim();
  return {
    businessName: form.businessName,
    ...(form.tagline.trim() !== '' ? { tagline: form.tagline } : {}),
    contact,
    ...(form.instagramUrl.trim() !== '' ? { instagramUrl: form.instagramUrl.trim() } : {}),
    ...(form.logo !== undefined && form.logo.mediaId !== '' ? { logo: form.logo } : {}),
    ...(form.footerNote.trim() !== '' ? { footerNote: form.footerNote } : {}),
    recommendationRules: form.rules.map((rule) => ({
      guestMin: wholeNumber(rule.guestMin),
      ...(rule.guestMax.trim() !== '' ? { guestMax: wholeNumber(rule.guestMax) } : {}),
      machineProductSlug: rule.machineProductSlug,
    })),
  };
}

/** Überschneidungen (Indizes der Formularzeilen) – nur Regeln mit gültigen Zahlen zählen. */
export function ruleOverlaps(rules: readonly CmsRuleForm[]): Array<[number, number]> {
  const valid: Array<{ index: number; rule: CmsRecommendationRule }> = [];
  rules.forEach((rule, index) => {
    const guestMin = wholeNumber(rule.guestMin);
    const guestMax = rule.guestMax.trim() === '' ? undefined : wholeNumber(rule.guestMax);
    if (!Number.isInteger(guestMin) || guestMin < 1) return;
    if (guestMax !== undefined && !Number.isInteger(guestMax)) return;
    valid.push({
      index,
      rule: {
        guestMin,
        ...(guestMax === undefined ? {} : { guestMax }),
        machineProductSlug: rule.machineProductSlug,
      },
    });
  });
  return overlappingRecommendationRules(valid.map((item) => item.rule)).map(([a, b]) => [
    valid[a]!.index,
    valid[b]!.index,
  ]);
}

function machineLabel(machine: CmsCatalogMachine): string {
  return `${machine.name} (${machine.containerCount} × ${machine.containerVolumeLiters.toLocaleString('de-DE')} L)`;
}

function RuleRow({
  index,
  rule,
  machines,
  overlapsWith,
  onChange,
  onRemove,
}: {
  index: number;
  rule: CmsRuleForm;
  machines: CmsCatalogMachine[] | null;
  overlapsWith: number[];
  onChange: (rule: CmsRuleForm) => void;
  onRemove: () => void;
}) {
  const { readOnly } = useContext(CmsEditorDataContext);
  const path = `recommendationRules.${index}`;
  const minIssues = useFieldIssues(`${path}.guestMin`);
  const maxIssues = useFieldIssues(`${path}.guestMax`);
  const machineIssues = useFieldIssues(`${path}.machineProductSlug`);
  const rowIssues = useFieldIssues(path);
  const known = machines?.some((m) => m.slug === rule.machineProductSlug) ?? false;
  return (
    <div
      className="card"
      style={{ padding: '0.75rem', marginBottom: '0.5rem' }}
      data-testid={`cms-rule-${index}`}
    >
      <div className="list-row" style={{ padding: '0 0 0.5rem' }}>
        <strong>Regel {index + 1}</strong>
        {!readOnly && (
          <button type="button" aria-label={`Regel ${index + 1} entfernen`} onClick={onRemove}>
            Entfernen
          </button>
        )}
      </div>
      <div className="grid-2">
        <div>
          <label htmlFor={`cms-rule-${index}-min`}>Gäste ab</label>
          <input
            id={`cms-rule-${index}-min`}
            data-testid={`cms-rule-${index}-min`}
            inputMode="numeric"
            value={rule.guestMin}
            onChange={(e) => onChange({ ...rule, guestMin: e.target.value })}
          />
          {minIssues.map((message) => (
            <p className="error" key={message}>
              {message}
            </p>
          ))}
        </div>
        <div>
          <label htmlFor={`cms-rule-${index}-max`}>Gäste bis (leer = ohne Obergrenze)</label>
          <input
            id={`cms-rule-${index}-max`}
            data-testid={`cms-rule-${index}-max`}
            inputMode="numeric"
            value={rule.guestMax}
            onChange={(e) => onChange({ ...rule, guestMax: e.target.value })}
          />
          {maxIssues.map((message) => (
            <p className="error" key={message}>
              {message}
            </p>
          ))}
        </div>
      </div>
      <label htmlFor={`cms-rule-${index}-machine`}>Empfohlene Maschine</label>
      {machines === null ? (
        <p className="muted">
          {rule.machineProductSlug === '' ? '–' : rule.machineProductSlug} (Maschinenliste braucht
          das Recht „Produkte ansehen“.)
        </p>
      ) : (
        <select
          id={`cms-rule-${index}-machine`}
          data-testid={`cms-rule-${index}-machine`}
          value={rule.machineProductSlug}
          onChange={(e) => onChange({ ...rule, machineProductSlug: e.target.value })}
        >
          <option value="">– bitte wählen –</option>
          {!known && rule.machineProductSlug !== '' && (
            <option value={rule.machineProductSlug}>
              {rule.machineProductSlug} – nicht (mehr) aktiv
            </option>
          )}
          {machines.map((machine) => (
            <option key={machine.slug} value={machine.slug}>
              {machineLabel(machine)}
            </option>
          ))}
        </select>
      )}
      {machineIssues.map((message) => (
        <p className="error" key={message}>
          {message}
        </p>
      ))}
      {rowIssues.map((message) => (
        <p className="error" key={message}>
          {message}
        </p>
      ))}
      {overlapsWith.length > 0 && (
        <p className="warning-red" role="status">
          Überschneidet sich mit {overlapsWith.map((other) => `Regel ${other + 1}`).join(', ')}.
        </p>
      )}
    </div>
  );
}

export function CmsSettingsFields({
  form,
  machines,
  onChange,
}: {
  form: CmsSettingsForm;
  machines: CmsCatalogMachine[] | null;
  onChange: (form: CmsSettingsForm) => void;
}) {
  const { readOnly } = useContext(CmsEditorDataContext);
  const overlaps = ruleOverlaps(form.rules);
  const overlapsOf = (index: number) =>
    overlaps.flatMap(([a, b]) => (a === index ? [b] : b === index ? [a] : []));
  const setRule = (index: number, rule: CmsRuleForm) =>
    onChange({ ...form, rules: form.rules.map((r, i) => (i === index ? rule : r)) });

  return (
    <>
      <section className="card">
        <h2>Allgemein</h2>
        <CmsTextField
          path="businessName"
          label="Firmenname"
          value={form.businessName}
          max={80}
          onChange={(businessName) => onChange({ ...form, businessName })}
        />
        <CmsTextField
          path="tagline"
          label="Kurzbeschreibung"
          value={form.tagline}
          max={160}
          optional
          onChange={(tagline) => onChange({ ...form, tagline })}
        />
        <CmsImageField
          path="logo"
          legend="Logo"
          value={form.logo}
          optional
          onChange={(logo) => onChange({ ...form, logo })}
        />
        <CmsTextField
          path="footerNote"
          label="Hinweis in der Fußzeile"
          value={form.footerNote}
          max={300}
          optional
          multiline
          onChange={(footerNote) => onChange({ ...form, footerNote })}
        />
      </section>

      <section className="card">
        <h2>Kontakt &amp; Links</h2>
        <p className="muted">
          Öffentliche Kontaktwerte nur eintragen, wenn sie bestätigt sind. Die genaue Abholadresse
          gehört nie auf die Website (öffentlich nur „Mainz-Hechtsheim“).
        </p>
        <div className="grid-2">
          <CmsTextField
            path="contact.phone"
            label="Telefon"
            value={form.phone}
            max={30}
            optional
            onChange={(phone) => onChange({ ...form, phone })}
          />
          <CmsTextField
            path="contact.email"
            label="E-Mail"
            value={form.email}
            max={200}
            optional
            onChange={(email) => onChange({ ...form, email })}
          />
        </div>
        <CmsTextField
          path="instagramUrl"
          label="Instagram-Link"
          value={form.instagramUrl}
          max={300}
          optional
          hint="Nur ein normaler Link (https://www.instagram.com/…) – kein Feed, keine Einbettung."
          onChange={(instagramUrl) => onChange({ ...form, instagramUrl })}
        />
      </section>

      <section className="card" data-testid="cms-rules">
        <h2>Maschinenempfehlung im Konfigurator</h2>
        <p className="muted">
          Einfache Regeln „Gästezahl von … bis … ⇒ Maschine“. Lücken sind erlaubt, Überschneidungen
          nicht. Ohne passende veröffentlichte Regel sieht der Kunde: „Wir prüfen persönlich, welche
          Maschine am besten zu deinem Event passt.“ Die Empfehlung ist nie bindend – Kunden können
          immer frei wählen, es gibt keine Verfügbarkeitszusage.
        </p>
        {form.rules.length === 0 && (
          <p className="muted" data-testid="cms-rules-empty">
            Keine Regeln gepflegt.
          </p>
        )}
        {overlaps.length > 0 && (
          <p className="conflict-box" role="alert" data-testid="cms-rules-overlap">
            Regeln überschneiden sich:{' '}
            {overlaps.map(([a, b]) => `Regel ${a + 1} und Regel ${b + 1}`).join('; ')}. Bitte die
            Gästebereiche so anpassen, dass jede Gästezahl höchstens zu einer Regel passt.
          </p>
        )}
        {form.rules.map((rule, index) => (
          <RuleRow
            key={index}
            index={index}
            rule={rule}
            machines={machines}
            overlapsWith={overlapsOf(index)}
            onChange={(next) => setRule(index, next)}
            onRemove={() => onChange({ ...form, rules: form.rules.filter((_, i) => i !== index) })}
          />
        ))}
        {!readOnly && (
          <button
            type="button"
            data-testid="cms-rule-add"
            disabled={form.rules.length >= 20}
            onClick={() =>
              onChange({
                ...form,
                rules: [...form.rules, { guestMin: '', guestMax: '', machineProductSlug: '' }],
              })
            }
          >
            Regel hinzufügen
          </button>
        )}
      </section>
    </>
  );
}
