export default function StaffHomePage() {
  return (
    <main
      style={{
        width: '100%',
        maxWidth: '28rem',
        background: '#ffffff',
        borderRadius: '0.75rem',
        border: '1px solid #e2e4e8',
        padding: '2rem',
        textAlign: 'center',
      }}
    >
      <h1 style={{ fontSize: '1.25rem', fontWeight: 600, marginTop: 0 }}>Miet-Royal Staff</h1>
      <p style={{ lineHeight: 1.6 }}>
        Die Mitarbeiter-App läuft. Anmeldung, „Heute“, Vorgänge, Kalender sowie Maschinen &amp;
        Lager folgen ab Phase 1.
      </p>
      <p style={{ color: '#666', fontSize: '0.875rem', marginBottom: 0 }}>
        Phase 0 – technischer Platzhalter ohne Fachfunktionen.
      </p>
    </main>
  );
}
