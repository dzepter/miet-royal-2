import type { Metadata } from 'next';
import { CmsRoute, cmsRouteMetadata } from '../../components/site/cms-route';

/** Phase 16 (WEB, Design §5): CMS-Seite /impressum – Impressum (Rechtstext, nur Textblöcke). */
const PATH = '/impressum';
const TYPES = ['legal'] as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsRouteMetadata(PATH, TYPES);
}

export default function ImprintPage() {
  return <CmsRoute path={PATH} expectedTypes={TYPES} />;
}
