import type { Metadata } from 'next';
import { CmsRoute, cmsRouteMetadata } from '../../components/site/cms-route';

/** Phase 16 (WEB, Design §5): CMS-Seite /ablauf – Ablauf. */
const PATH = '/ablauf';
const TYPES = ['process'] as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsRouteMetadata(PATH, TYPES);
}

export default function ProcessPage() {
  return <CmsRoute path={PATH} expectedTypes={TYPES} />;
}
