'use client';

import { useState } from 'react';
import { VIEW_LABELS, type DamageMarkerShape, type DamageViewSide } from '../lib/returns';

/**
 * Schadensdiagramm (Phase-7-Order §§28–30, 63): neutrales, schematisches
 * Maschinenschema je Ansicht (vorne/hinten/links/rechts) als Platzhalter –
 * KEINE Explosionszeichnung, keine Hersteller-/Internetbilder. Markierungen
 * werden als normalisierte Koordinaten (0..1) geführt; echte Miet-Royal-
 * Grafiken können später über `MACHINE_SKETCH_ASSETS` je Maschinentyp
 * hinterlegt werden, ohne die Datenstruktur zu ändern.
 */
export const MACHINE_SKETCH_ASSETS: Partial<
  Record<string, Partial<Record<DamageViewSide, string>>>
> = {};

const VIEWS: DamageViewSide[] = ['front', 'back', 'left', 'right'];
const WIDTH = 220;
const HEIGHT = 280;
const AREA_W = 0.16;
const AREA_H = 0.12;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function DamageDiagram({
  markers,
  editable = false,
  markerType = 'point',
  onAddMarker,
  onRemoveMarker,
  productSlug,
  compact = false,
  testId = 'damage-diagram',
}: {
  markers: DamageMarkerShape[];
  editable?: boolean;
  markerType?: 'point' | 'area';
  onAddMarker?: (marker: DamageMarkerShape) => void;
  onRemoveMarker?: (index: number) => void;
  productSlug?: string | undefined;
  compact?: boolean;
  testId?: string;
}) {
  const [view, setView] = useState<DamageViewSide>('front');
  const scale = compact ? 0.5 : 1;
  const asset = productSlug === undefined ? undefined : MACHINE_SKETCH_ASSETS[productSlug]?.[view];

  function handleClick(event: React.MouseEvent<SVGSVGElement>) {
    if (!editable || onAddMarker === undefined) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = clamp01((event.clientX - rect.left) / rect.width);
    const y = clamp01((event.clientY - rect.top) / rect.height);
    if (markerType === 'area') {
      const ax = clamp01(Math.min(x - AREA_W / 2, 1 - AREA_W));
      const ay = clamp01(Math.min(y - AREA_H / 2, 1 - AREA_H));
      onAddMarker({ view, markerType: 'area', x: ax, y: ay, width: AREA_W, height: AREA_H });
    } else {
      onAddMarker({ view, markerType: 'point', x, y, width: null, height: null });
    }
  }

  return (
    <div className="damage-diagram" data-testid={testId}>
      <div className="diagram-tabs" role="tablist" aria-label="Ansicht">
        {VIEWS.map((side) => {
          const count = markers.filter((marker) => marker.view === side).length;
          return (
            <button
              key={side}
              type="button"
              role="tab"
              aria-selected={view === side}
              className={view === side ? 'active' : ''}
              data-testid={`${testId}-view-${side}`}
              onClick={() => setView(side)}
            >
              {VIEW_LABELS[side]}
              {count > 0 ? ` (${count})` : ''}
            </button>
          );
        })}
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width={WIDTH * scale}
        height={HEIGHT * scale}
        role="img"
        aria-label={`Maschinenschema ${VIEW_LABELS[view]}`}
        data-testid={`${testId}-svg`}
        onClick={handleClick}
        style={{ cursor: editable ? 'crosshair' : 'default', touchAction: 'none' }}
      >
        {asset !== undefined ? (
          <image href={asset} x={0} y={0} width={WIDTH} height={HEIGHT} />
        ) : (
          <g stroke="#666" fill="#fafafa" strokeWidth={1.5}>
            {/* Neutrales Schema: Gehäuse, Behälterbereich, Sockel/Tropfschale. */}
            <rect x={10} y={10} width={WIDTH - 20} height={HEIGHT - 20} rx={10} />
            <rect
              x={WIDTH * 0.18}
              y={HEIGHT * 0.1}
              width={WIDTH * 0.64}
              height={HEIGHT * 0.4}
              rx={6}
            />
            <rect
              x={WIDTH * 0.12}
              y={HEIGHT * 0.6}
              width={WIDTH * 0.76}
              height={HEIGHT * 0.28}
              rx={6}
            />
            <text
              x={WIDTH / 2}
              y={HEIGHT - 18}
              textAnchor="middle"
              fontSize={11}
              fill="#777"
              stroke="none"
            >
              Schema {VIEW_LABELS[view]} (Platzhalter)
            </text>
          </g>
        )}
        {markers.map((marker, index) =>
          marker.view !== view ? null : marker.markerType === 'area' &&
            marker.width !== null &&
            marker.height !== null ? (
            <rect
              key={index}
              data-testid={`${testId}-marker-${index}`}
              x={marker.x * WIDTH}
              y={marker.y * HEIGHT}
              width={marker.width * WIDTH}
              height={marker.height * HEIGHT}
              fill="rgba(179,38,30,0.25)"
              stroke="#b3261e"
              strokeWidth={2}
              onClick={(event) => {
                if (!editable || onRemoveMarker === undefined) return;
                event.stopPropagation();
                onRemoveMarker(index);
              }}
            />
          ) : (
            <circle
              key={index}
              data-testid={`${testId}-marker-${index}`}
              cx={marker.x * WIDTH}
              cy={marker.y * HEIGHT}
              r={7}
              fill="#b3261e"
              stroke="#fff"
              strokeWidth={2}
              onClick={(event) => {
                if (!editable || onRemoveMarker === undefined) return;
                event.stopPropagation();
                onRemoveMarker(index);
              }}
            />
          ),
        )}
      </svg>
      {editable && (
        <p className="muted" style={{ margin: '0.3rem 0 0' }}>
          Auf das Schema tippen, um eine Markierung zu setzen (Markierung antippen entfernt sie).
        </p>
      )}
    </div>
  );
}
