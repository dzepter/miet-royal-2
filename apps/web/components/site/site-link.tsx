import Link from 'next/link';
import type { ReactNode } from 'react';
import { resolveSiteHref } from '../../lib/site-nav';

/**
 * Phase 16 (WEB, Design §5): Link aus CMS-Inhalten. Interne Ziele nur, wenn die Seite
 * existiert (App-Seite oder veröffentlichte CMS-Seite) – sonst wird der Link ausgeblendet.
 * Externe Ziele nur https mit `rel="noopener noreferrer"`; mailto:/tel: direkt.
 */
export function SiteLink({
  href,
  published,
  className,
  children,
  testId,
}: {
  href: string;
  published: ReadonlySet<string>;
  className?: string | undefined;
  children: ReactNode;
  testId?: string | undefined;
}) {
  const resolved = resolveSiteHref(href, published);
  if (resolved === null) return null;
  if (resolved.kind === 'internal') {
    return (
      <Link href={resolved.href} prefetch={false} className={className} data-testid={testId}>
        {children}
      </Link>
    );
  }
  if (resolved.kind === 'external') {
    return (
      <a href={resolved.href} rel="noopener noreferrer" className={className} data-testid={testId}>
        {children}
      </a>
    );
  }
  return (
    <a href={resolved.href} className={className} data-testid={testId}>
      {children}
    </a>
  );
}
