import { imageDefaultSrc, imageSrcSet, isOwnMediaUrl } from '../../lib/site-blocks';
import type { PublicImage } from '../../lib/site-types';

/**
 * Phase 16 (WEB, Design §5 „Renderer“): CMS-Bild als `<img>` mit `srcSet` aus den
 * WebP-Varianten der opaken Medienroute (keine Storage-Keys, keine fremden Hosts).
 * Dekorativ ⇒ `alt=""` + `aria-hidden`; außer im Hero immer `loading="lazy"`.
 */
export function SiteImage({
  image,
  sizes,
  priority = false,
  className,
}: {
  image: PublicImage;
  sizes: string;
  priority?: boolean;
  className?: string | undefined;
}) {
  const variants = image.variants.filter((variant) => isOwnMediaUrl(variant.url));
  const src = imageDefaultSrc(variants);
  if (src === null) return null;
  // Bewusst <img> statt next/image: die Varianten liefert die API selbst (opake Medienroute).
  return (
    <img
      src={src}
      srcSet={imageSrcSet(variants)}
      sizes={sizes}
      width={image.width}
      height={image.height}
      alt={image.decorative ? '' : image.alt}
      aria-hidden={image.decorative ? true : undefined}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : undefined}
      decoding="async"
      className={className}
    />
  );
}
