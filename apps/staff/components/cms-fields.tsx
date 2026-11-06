'use client';

import type { CmsBlock, CmsCta, CmsImageRef } from '@mietroyal/validation/cms';
import { createContext, useContext, type ReactNode } from 'react';
import { CMS_BLOCK_TYPE_HINTS, cmsStaffMediaUrl, type StaffCmsMedia } from '../lib/cms';

/**
 * Phase 16 (STAFF): Formularbausteine des Website-Editors – ein Formular je Blocktyp
 * (alle 14 Typen aus `@mietroyal/validation/cms`). Reine Eingabe: Inhalte werden als
 * strukturierte Blöcke gepflegt (kein HTML), Bilder nur über die Medienliste (opake ID)
 * mit Alt-Text oder ausdrücklich „dekorativ“, Preise nie (kommen aus dem Katalog).
 * Lesemodus (nur cms.publish): das umgebende `<fieldset disabled>` sperrt alle Felder.
 */

// ── Kontext: Prüfmeldungen und Auswahldaten ───────────────────────────────

/** Prüfmeldungen je Editor-Pfad („blocks.2.items.0.title“). */
export const CmsIssueContext = createContext<ReadonlyMap<string, string[]>>(new Map());

export function useFieldIssues(path: string): string[] {
  return useContext(CmsIssueContext).get(path) ?? [];
}

export interface CmsProductOption {
  slug: string;
  name: string;
  categoryLabel: string;
}

export interface CmsEditorData {
  media: StaffCmsMedia[];
  /** Medienliste neu laden (z. B. nach einem Upload in einem anderen Tab). */
  reloadMedia: () => void;
  /** Aktive Produkte für `product_grid`; null ⇒ ohne Recht „Produkte ansehen“ nicht ladbar. */
  products: CmsProductOption[] | null;
  readOnly: boolean;
}

export const CmsEditorDataContext = createContext<CmsEditorData>({
  media: [],
  reloadMedia: () => undefined,
  products: null,
  readOnly: true,
});

function fieldId(path: string): string {
  return `cms-${path.replace(/[^a-zA-Z0-9]+/g, '-')}`;
}

function FieldIssues({ path }: { path: string }) {
  const issues = useFieldIssues(path);
  if (issues.length === 0) return null;
  return (
    <>
      {issues.map((message) => (
        <p className="error" key={message} data-testid={`${fieldId(path)}-issue`}>
          {message}
        </p>
      ))}
    </>
  );
}

// ── Einfache Felder ────────────────────────────────────────────────────────

export function CmsTextField({
  path,
  label,
  value,
  max,
  optional = false,
  multiline = false,
  rows = 3,
  hint,
  onChange,
}: {
  path: string;
  label: string;
  value: string | undefined;
  max: number;
  optional?: boolean;
  multiline?: boolean;
  rows?: number;
  hint?: string;
  onChange: (value: string) => void;
}) {
  const id = fieldId(path);
  const current = value ?? '';
  const issues = useFieldIssues(path);
  const tooLong = current.trim().length > max;
  const common = {
    id,
    value: current,
    'aria-invalid': issues.length > 0 || tooLong,
    'aria-describedby': `${id}-count`,
    'data-testid': id,
  };
  return (
    <div>
      <label htmlFor={id}>
        {label}
        {optional ? ' (optional)' : ''}
      </label>
      {multiline ? (
        <textarea {...common} rows={rows} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input {...common} onChange={(e) => onChange(e.target.value)} />
      )}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: '0.5rem',
          marginTop: '-0.5rem',
          marginBottom: '0.5rem',
        }}
      >
        <span className="muted">{hint}</span>
        <span id={`${id}-count`} className={tooLong ? 'warning-red' : 'muted'}>
          {current.trim().length}/{max} Zeichen
        </span>
      </div>
      <FieldIssues path={path} />
    </div>
  );
}

/** Button (Beschriftung + Ziel): interner Pfad wie „/konfigurator“, https-Adresse, mailto: oder tel:. */
export function CmsCtaField({
  path,
  legend,
  value,
  optional = false,
  onChange,
}: {
  path: string;
  legend: string;
  value: CmsCta | undefined;
  optional?: boolean;
  onChange: (value: CmsCta) => void;
}) {
  const current = value ?? { label: '', href: '' };
  return (
    <div className="card" style={{ padding: '0.75rem', marginBottom: '0.75rem' }}>
      <strong>
        {legend}
        {optional ? ' (optional)' : ''}
      </strong>
      <div className="grid-2">
        <CmsTextField
          path={`${path}.label`}
          label="Beschriftung"
          value={current.label}
          max={60}
          onChange={(label) => onChange({ ...current, label })}
        />
        <CmsTextField
          path={`${path}.href`}
          label="Ziel"
          value={current.href}
          max={300}
          hint="z. B. /konfigurator, /kontakt, https://…, mailto:…, tel:…"
          onChange={(href) => onChange({ ...current, href })}
        />
      </div>
      <FieldIssues path={path} />
    </div>
  );
}

/** Bildwahl aus der Medienliste mit Alt-Text oder „dekorativ“ (Order §8). */
export function CmsImageField({
  path,
  legend,
  value,
  optional = false,
  onChange,
}: {
  path: string;
  legend: string;
  value: CmsImageRef | undefined;
  optional?: boolean;
  onChange: (value: CmsImageRef | undefined) => void;
}) {
  const { media, readOnly, reloadMedia } = useContext(CmsEditorDataContext);
  const id = fieldId(path);
  const selected = value === undefined ? undefined : media.find((m) => m.id === value.mediaId);
  const unknownSelection = value !== undefined && value.mediaId !== '' && selected === undefined;

  function choose(mediaId: string) {
    if (mediaId === '') {
      onChange(optional ? undefined : { mediaId: '', alt: '', decorative: false });
      return;
    }
    const item = media.find((m) => m.id === mediaId);
    const decorative = value?.decorative ?? false;
    const alt = decorative
      ? ''
      : value !== undefined && value.alt !== ''
        ? value.alt
        : (item?.defaultAlt ?? '');
    onChange({ mediaId, alt, decorative });
  }

  return (
    <div className="card" style={{ padding: '0.75rem', marginBottom: '0.75rem' }}>
      <strong>
        {legend}
        {optional ? ' (optional)' : ''}
      </strong>
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {selected !== undefined && (
          // Staff-Vorschau über die Sitzung (private, no-store) – nie der Storage-Key.
          <img
            src={cmsStaffMediaUrl(selected)}
            alt={`Vorschau: ${selected.label}`}
            className="photo-thumb"
            style={{ marginTop: '0.5rem' }}
          />
        )}
        <div style={{ flex: '1 1 16rem' }}>
          <label htmlFor={`${id}-media`}>Bild aus der Medienliste</label>
          <select
            id={`${id}-media`}
            data-testid={`${id}-media`}
            value={value?.mediaId ?? ''}
            onChange={(e) => choose(e.target.value)}
          >
            <option value="">{optional ? '– kein Bild –' : '– bitte wählen –'}</option>
            {unknownSelection && (
              <option value={value.mediaId}>Bild nicht in der Medienliste</option>
            )}
            {media.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label} ({item.width}×{item.height})
              </option>
            ))}
          </select>
          <FieldIssues path={`${path}.mediaId`} />
          {value !== undefined && value.mediaId !== '' && (
            <>
              <label className="perm-item">
                <input
                  type="checkbox"
                  data-testid={`${id}-decorative`}
                  checked={value.decorative}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      decorative: e.target.checked,
                      alt: e.target.checked ? '' : (selected?.defaultAlt ?? ''),
                    })
                  }
                />
                <span>Dekoratives Bild (ohne inhaltliche Aussage, kein Alt-Text)</span>
              </label>
              {!value.decorative && (
                <CmsTextField
                  path={`${path}.alt`}
                  label="Alt-Text (beschreibt das Bild für Screenreader)"
                  value={value.alt}
                  max={200}
                  onChange={(alt) => onChange({ ...value, alt })}
                />
              )}
              {value.decorative && <FieldIssues path={`${path}.alt`} />}
            </>
          )}
          {!readOnly && (
            <p className="muted">
              {media.length === 0 ? 'Noch keine Bilder hochgeladen. ' : ''}
              <a href="/website/medien" target="_blank" rel="noopener">
                Medien verwalten (neuer Tab)
              </a>{' '}
              ·{' '}
              <button type="button" className="link-like" onClick={reloadMedia}>
                Liste aktualisieren
              </button>
            </p>
          )}
        </div>
      </div>
      <FieldIssues path={path} />
    </div>
  );
}

// ── Listen ─────────────────────────────────────────────────────────────────

function ListControls({
  index,
  count,
  min,
  onMove,
  onRemove,
  noun,
}: {
  index: number;
  count: number;
  min: number;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  noun: string;
}) {
  const { readOnly } = useContext(CmsEditorDataContext);
  if (readOnly) return null;
  return (
    <span style={{ display: 'inline-flex', gap: '0.25rem', flexWrap: 'wrap' }}>
      <button
        type="button"
        aria-label={`${noun} ${index + 1} nach oben`}
        disabled={index === 0}
        onClick={() => onMove(index, index - 1)}
      >
        ↑
      </button>
      <button
        type="button"
        aria-label={`${noun} ${index + 1} nach unten`}
        disabled={index === count - 1}
        onClick={() => onMove(index, index + 1)}
      >
        ↓
      </button>
      <button
        type="button"
        aria-label={`${noun} ${index + 1} entfernen`}
        disabled={count <= min}
        onClick={() => onRemove(index)}
      >
        Entfernen
      </button>
    </span>
  );
}

function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

function AddButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const { readOnly } = useContext(CmsEditorDataContext);
  if (readOnly) return null;
  return (
    <button type="button" disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
}

type TitledItem = { title: string; text: string };

function TitledItemsField({
  path,
  items,
  max,
  noun,
  onChange,
}: {
  path: string;
  items: TitledItem[];
  max: number;
  noun: string;
  onChange: (items: TitledItem[]) => void;
}) {
  return (
    <div>
      {items.map((item, index) => (
        <div key={index} className="card" style={{ padding: '0.75rem', marginBottom: '0.5rem' }}>
          <div className="list-row" style={{ padding: '0 0 0.5rem' }}>
            <strong>
              {noun} {index + 1}
            </strong>
            <ListControls
              index={index}
              count={items.length}
              min={1}
              noun={noun}
              onMove={(from, to) => onChange(moved(items, from, to))}
              onRemove={(at) => onChange(items.filter((_, i) => i !== at))}
            />
          </div>
          <CmsTextField
            path={`${path}.${index}.title`}
            label="Titel"
            value={item.title}
            max={80}
            onChange={(title) =>
              onChange(items.map((it, i) => (i === index ? { ...it, title } : it)))
            }
          />
          <CmsTextField
            path={`${path}.${index}.text`}
            label="Text"
            value={item.text}
            max={600}
            multiline
            onChange={(text) =>
              onChange(items.map((it, i) => (i === index ? { ...it, text } : it)))
            }
          />
        </div>
      ))}
      <FieldIssues path={path} />
      <AddButton
        label={`${noun} hinzufügen`}
        disabled={items.length >= max}
        onClick={() => onChange([...items, { title: '', text: '' }])}
      />{' '}
      <span className="muted">
        {items.length}/{max}
      </span>
    </div>
  );
}

type FaqItem = { question: string; answer: string };

function FaqItemsField({
  path,
  items,
  onChange,
}: {
  path: string;
  items: FaqItem[];
  onChange: (items: FaqItem[]) => void;
}) {
  const max = 40;
  return (
    <div>
      {items.map((item, index) => (
        <div key={index} className="card" style={{ padding: '0.75rem', marginBottom: '0.5rem' }}>
          <div className="list-row" style={{ padding: '0 0 0.5rem' }}>
            <strong>Frage {index + 1}</strong>
            <ListControls
              index={index}
              count={items.length}
              min={1}
              noun="Frage"
              onMove={(from, to) => onChange(moved(items, from, to))}
              onRemove={(at) => onChange(items.filter((_, i) => i !== at))}
            />
          </div>
          <CmsTextField
            path={`${path}.${index}.question`}
            label="Frage"
            value={item.question}
            max={200}
            onChange={(question) =>
              onChange(items.map((it, i) => (i === index ? { ...it, question } : it)))
            }
          />
          <CmsTextField
            path={`${path}.${index}.answer`}
            label="Antwort"
            value={item.answer}
            max={3000}
            multiline
            rows={4}
            onChange={(answer) =>
              onChange(items.map((it, i) => (i === index ? { ...it, answer } : it)))
            }
          />
        </div>
      ))}
      <FieldIssues path={path} />
      <AddButton
        label="Frage hinzufügen"
        disabled={items.length >= max}
        onClick={() => onChange([...items, { question: '', answer: '' }])}
      />{' '}
      <span className="muted">
        {items.length}/{max}
      </span>
    </div>
  );
}

function AreasField({
  path,
  areas,
  onChange,
}: {
  path: string;
  areas: string[];
  onChange: (areas: string[]) => void;
}) {
  const max = 20;
  return (
    <div>
      <strong>Orte</strong>
      {areas.map((area, index) => (
        <div
          key={index}
          style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}
        >
          <div style={{ flex: '1 1 12rem' }}>
            <CmsTextField
              path={`${path}.${index}`}
              label={`Ort ${index + 1}`}
              value={area}
              max={60}
              onChange={(value) => onChange(areas.map((a, i) => (i === index ? value : a)))}
            />
          </div>
          <div style={{ paddingTop: '1.4rem' }}>
            <ListControls
              index={index}
              count={areas.length}
              min={1}
              noun="Ort"
              onMove={(from, to) => onChange(moved(areas, from, to))}
              onRemove={(at) => onChange(areas.filter((_, i) => i !== at))}
            />
          </div>
        </div>
      ))}
      <FieldIssues path={path} />
      <AddButton
        label="Ort hinzufügen"
        disabled={areas.length >= max}
        onClick={() => onChange([...areas, ''])}
      />{' '}
      <span className="muted">
        {areas.length}/{max}
      </span>
    </div>
  );
}

function GalleryImagesField({
  path,
  images,
  onChange,
}: {
  path: string;
  images: CmsImageRef[];
  onChange: (images: CmsImageRef[]) => void;
}) {
  const max = 12;
  return (
    <div>
      {images.map((image, index) => (
        <div key={index}>
          <div className="list-row" style={{ padding: '0.25rem 0' }}>
            <span className="muted">Bild {index + 1}</span>
            <ListControls
              index={index}
              count={images.length}
              min={1}
              noun="Bild"
              onMove={(from, to) => onChange(moved(images, from, to))}
              onRemove={(at) => onChange(images.filter((_, i) => i !== at))}
            />
          </div>
          <CmsImageField
            path={`${path}.${index}`}
            legend={`Bild ${index + 1}`}
            value={image}
            onChange={(next) =>
              onChange(
                images.map((img, i) =>
                  i === index ? (next ?? { mediaId: '', alt: '', decorative: false }) : img,
                ),
              )
            }
          />
        </div>
      ))}
      <FieldIssues path={path} />
      <AddButton
        label="Bild hinzufügen"
        disabled={images.length >= max}
        onClick={() => onChange([...images, { mediaId: '', alt: '', decorative: false }])}
      />{' '}
      <span className="muted">
        {images.length}/{max}
      </span>
    </div>
  );
}

/** Produktauswahl für `product_grid` – nur Slugs; Name/Preis liefert die Website aus dem Katalog. */
function ProductSlugsField({
  path,
  slugs,
  onChange,
}: {
  path: string;
  slugs: string[];
  onChange: (slugs: string[]) => void;
}) {
  const { products } = useContext(CmsEditorDataContext);
  const max = 6;
  if (products === null) {
    return (
      <div>
        <p className="muted">
          {slugs.length === 0
            ? 'Keine eigene Auswahl – es erscheinen die Slush-Maschinen.'
            : `Ausgewählte Produkte: ${slugs.join(', ')}`}{' '}
          Für die Produktauswahl brauchst du das Recht „Produkte ansehen“.
        </p>
        <FieldIssues path={path} />
      </div>
    );
  }
  const known = new Set(products.map((p) => p.slug));
  const unknown = slugs.filter((slug) => !known.has(slug));
  return (
    <div>
      <strong>Produktauswahl (optional, höchstens {max})</strong>
      <p className="muted">
        Ohne Auswahl erscheinen automatisch die Slush-Maschinen. Reihenfolge = Reihenfolge der
        Auswahl.
      </p>
      {products.map((product) => {
        const checked = slugs.includes(product.slug);
        return (
          <label className="perm-item" key={product.slug}>
            <input
              type="checkbox"
              checked={checked}
              disabled={!checked && slugs.length >= max}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...slugs, product.slug]
                    : slugs.filter((slug) => slug !== product.slug),
                )
              }
            />
            <span>
              {product.name} <span className="muted">({product.categoryLabel})</span>
              {checked && <span className="badge">Position {slugs.indexOf(product.slug) + 1}</span>}
            </span>
          </label>
        );
      })}
      {unknown.length > 0 && (
        <p className="muted">
          Nicht (mehr) aktiv und daher nicht angezeigt: {unknown.join(', ')}{' '}
          <button type="button" onClick={() => onChange(slugs.filter((slug) => known.has(slug)))}>
            Entfernen
          </button>
        </p>
      )}
      <FieldIssues path={path} />
    </div>
  );
}

// ── Blockformulare ─────────────────────────────────────────────────────────

function HeadingIntro({
  path,
  heading,
  intro,
  onHeading,
  onIntro,
}: {
  path: string;
  heading: string | undefined;
  intro?: string | undefined;
  onHeading: (value: string) => void;
  onIntro?: (value: string) => void;
}) {
  return (
    <>
      <CmsTextField
        path={`${path}.heading`}
        label="Überschrift"
        value={heading}
        max={120}
        optional
        onChange={onHeading}
      />
      {onIntro !== undefined && (
        <CmsTextField
          path={`${path}.intro`}
          label="Einleitung"
          value={intro}
          max={800}
          optional
          multiline
          onChange={onIntro}
        />
      )}
    </>
  );
}

/** Formular für genau einen Block; `path` = „blocks.<index>“. */
export function CmsBlockFields({
  path,
  block,
  onChange,
}: {
  path: string;
  block: CmsBlock;
  onChange: (block: CmsBlock) => void;
}) {
  const hint = CMS_BLOCK_TYPE_HINTS[block.type];
  let fields: ReactNode;
  switch (block.type) {
    case 'hero':
      fields = (
        <>
          <CmsTextField
            path={`${path}.heading`}
            label="Überschrift"
            value={block.heading}
            max={120}
            onChange={(heading) => onChange({ ...block, heading })}
          />
          <CmsTextField
            path={`${path}.lead`}
            label="Einleitung"
            value={block.lead}
            max={400}
            optional
            multiline
            onChange={(lead) => onChange({ ...block, lead })}
          />
          <CmsImageField
            path={`${path}.image`}
            legend="Bild"
            value={block.image}
            optional
            onChange={(image) => onChange({ ...block, image })}
          />
          <CmsCtaField
            path={`${path}.primaryCta`}
            legend="Haupt-Button"
            value={block.primaryCta}
            optional
            onChange={(primaryCta) => onChange({ ...block, primaryCta })}
          />
          <CmsCtaField
            path={`${path}.secondaryCta`}
            legend="Zweiter Button"
            value={block.secondaryCta}
            optional
            onChange={(secondaryCta) => onChange({ ...block, secondaryCta })}
          />
        </>
      );
      break;
    case 'text':
      fields = (
        <>
          <HeadingIntro
            path={path}
            heading={block.heading}
            onHeading={(heading) => onChange({ ...block, heading })}
          />
          <CmsTextField
            path={`${path}.body`}
            label="Text"
            value={block.body}
            max={8000}
            multiline
            rows={8}
            hint="Reiner Text, Absätze durch eine Leerzeile trennen. Kein HTML."
            onChange={(body) => onChange({ ...block, body })}
          />
        </>
      );
      break;
    case 'features':
    case 'steps':
      fields = (
        <>
          <HeadingIntro
            path={path}
            heading={block.heading}
            intro={block.intro}
            onHeading={(heading) => onChange({ ...block, heading })}
            onIntro={(intro) => onChange({ ...block, intro })}
          />
          <TitledItemsField
            path={`${path}.items`}
            items={block.items}
            max={block.type === 'features' ? 6 : 8}
            noun={block.type === 'features' ? 'Vorteil' : 'Schritt'}
            onChange={(items) => onChange({ ...block, items })}
          />
        </>
      );
      break;
    case 'product_grid':
      fields = (
        <>
          <HeadingIntro
            path={path}
            heading={block.heading}
            intro={block.intro}
            onHeading={(heading) => onChange({ ...block, heading })}
            onIntro={(intro) => onChange({ ...block, intro })}
          />
          <ProductSlugsField
            path={`${path}.productSlugs`}
            slugs={block.productSlugs ?? []}
            onChange={(productSlugs) => onChange({ ...block, productSlugs })}
          />
        </>
      );
      break;
    case 'included_items':
    case 'reviews':
    case 'secondary_offers':
    case 'contact_details':
      fields = (
        <HeadingIntro
          path={path}
          heading={block.heading}
          intro={block.intro}
          onHeading={(heading) => onChange({ ...block, heading })}
          onIntro={(intro) => onChange({ ...block, intro })}
        />
      );
      break;
    case 'image':
      fields = (
        <>
          <CmsImageField
            path={`${path}.image`}
            legend="Bild"
            value={block.image}
            onChange={(image) =>
              onChange({ ...block, image: image ?? { mediaId: '', alt: '', decorative: false } })
            }
          />
          <CmsTextField
            path={`${path}.caption`}
            label="Bildunterschrift"
            value={block.caption}
            max={200}
            optional
            onChange={(caption) => onChange({ ...block, caption })}
          />
        </>
      );
      break;
    case 'gallery':
      fields = (
        <>
          <HeadingIntro
            path={path}
            heading={block.heading}
            onHeading={(heading) => onChange({ ...block, heading })}
          />
          <GalleryImagesField
            path={`${path}.images`}
            images={block.images}
            onChange={(images) => onChange({ ...block, images })}
          />
        </>
      );
      break;
    case 'faq':
      fields = (
        <>
          <HeadingIntro
            path={path}
            heading={block.heading}
            onHeading={(heading) => onChange({ ...block, heading })}
          />
          <FaqItemsField
            path={`${path}.items`}
            items={block.items}
            onChange={(items) => onChange({ ...block, items })}
          />
        </>
      );
      break;
    case 'service_areas':
      fields = (
        <>
          <HeadingIntro
            path={path}
            heading={block.heading}
            intro={block.intro}
            onHeading={(heading) => onChange({ ...block, heading })}
            onIntro={(intro) => onChange({ ...block, intro })}
          />
          <AreasField
            path={`${path}.areas`}
            areas={block.areas}
            onChange={(areas) => onChange({ ...block, areas })}
          />
        </>
      );
      break;
    case 'cta':
      fields = (
        <>
          <CmsTextField
            path={`${path}.heading`}
            label="Überschrift"
            value={block.heading}
            max={120}
            onChange={(heading) => onChange({ ...block, heading })}
          />
          <CmsTextField
            path={`${path}.text`}
            label="Text"
            value={block.text}
            max={500}
            optional
            multiline
            onChange={(text) => onChange({ ...block, text })}
          />
          <CmsCtaField
            path={`${path}.primary`}
            legend="Haupt-Button"
            value={block.primary}
            onChange={(primary) => onChange({ ...block, primary })}
          />
          <CmsCtaField
            path={`${path}.secondary`}
            legend="Zweiter Button"
            value={block.secondary}
            optional
            onChange={(secondary) => onChange({ ...block, secondary })}
          />
        </>
      );
      break;
  }
  return (
    <div>
      {hint !== undefined && <p className="muted">{hint}</p>}
      {fields}
    </div>
  );
}
