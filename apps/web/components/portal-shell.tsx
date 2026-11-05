'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { PORTAL_ROUTES, portalFetch } from '../lib/portal';

/**
 * Phase 15 (Design §5): Portal-Shell mit Navigation (Übersicht / Profil /
 * Abmelden). Auf Seiten ohne Session (Anmeldung, Bestätigung der neuen
 * E-Mail-Adresse) wird die Navigation nicht angezeigt. Die Shell lädt selbst
 * keine Kontodaten; die Session steckt nur im HttpOnly-Cookie der API.
 */

const NO_NAV_PATHS: readonly string[] = [PORTAL_ROUTES.login, PORTAL_ROUTES.emailChange];

const navLink: React.CSSProperties = {
  color: '#1a1a1a',
  textDecoration: 'none',
  padding: '0.5rem 0.75rem',
  borderRadius: 6,
  fontWeight: 600,
};

export function PortalShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  const showNav = !NO_NAV_PATHS.includes(pathname);

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await portalFetch<undefined>('/auth/logout', { method: 'POST' });
    } catch {
      // Abmelden ist auch ohne gültige Session „erfolgreich“ (Cookie weg) –
      // Netzfehler ändern nichts daran, dass wir zur Anmeldung wechseln.
    }
    setLoggingOut(false);
    router.replace(PORTAL_ROUTES.login);
  }

  return (
    <>
      <header
        style={{
          background: '#ffffff',
          borderBottom: '1px solid #e2e2e2',
          padding: '0.6rem 1rem',
        }}
      >
        <div
          style={{
            maxWidth: '44rem',
            margin: '0 auto',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.5rem',
          }}
        >
          <span style={{ fontWeight: 700 }}>Miet-Royal · Kundenbereich</span>
          {showNav && (
            <nav aria-label="Kundenbereich" data-testid="portal-nav">
              <ul
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.25rem',
                }}
              >
                <li>
                  <Link
                    href={PORTAL_ROUTES.home}
                    prefetch={false}
                    style={navLink}
                    aria-current={pathname === PORTAL_ROUTES.home ? 'page' : undefined}
                    data-testid="portal-nav-home"
                  >
                    Übersicht
                  </Link>
                </li>
                <li>
                  <Link
                    href={PORTAL_ROUTES.profile}
                    prefetch={false}
                    style={navLink}
                    aria-current={pathname === PORTAL_ROUTES.profile ? 'page' : undefined}
                    data-testid="portal-nav-profile"
                  >
                    Profil
                  </Link>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => void logout()}
                    disabled={loggingOut}
                    data-testid="portal-logout"
                    style={{
                      ...navLink,
                      background: 'none',
                      border: '1px solid #8a8a8a',
                      cursor: loggingOut ? 'wait' : 'pointer',
                      fontSize: '1rem',
                    }}
                  >
                    Abmelden
                  </button>
                </li>
              </ul>
            </nav>
          )}
        </div>
      </header>
      {children}
    </>
  );
}
