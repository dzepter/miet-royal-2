'use client';

import { useEffect, useState } from 'react';
import { isLocalId, mediaIdFromLocalPhotoId } from '../lib/offline/projection';
import { offlineRuntime } from '../lib/offline/runtime';

/**
 * Foto-Vorschau in den Wizards (Phase-8-Order §§12, 19): serverseitige Fotos
 * kommen wie bisher über die API; lokal erfasste (`local:<mediaId>`) werden
 * aus dem verschlüsselten Store entschlüsselt und als Blob-URL angezeigt –
 * nie über den Cache, nie über eine URL außerhalb der Seite.
 */
export function PhotoThumb({ id, src, alt }: { id: string; src: string; alt: string }) {
  const local = isLocalId(id);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!local) return;
    const mediaId = mediaIdFromLocalPhotoId(id);
    if (mediaId === null) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    void offlineRuntime()
      .getMediaBytes(mediaId)
      .then((media) => {
        if (cancelled || media === null) return;
        objectUrl = URL.createObjectURL(
          new Blob([media.bytes as BlobPart], { type: media.mimeType }),
        );
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [id, local]);

  if (!local) return <img className="photo-thumb" src={src} alt={alt} />;
  if (url === null) {
    return (
      <span className="badge" data-local="true" aria-label={alt}>
        Foto lokal gespeichert
      </span>
    );
  }
  return <img className="photo-thumb" data-local="true" src={url} alt={alt} />;
}
