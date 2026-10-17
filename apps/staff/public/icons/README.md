# App-Icons (Platzhalter)

Neutrale Platzhalter-Icons der Staff-PWA (Phase 8). Sie sind bewusst kein
Branding und können 1:1 durch die finalen Grafiken ersetzt werden – die
Dateinamen und Größen sind in `../manifest.webmanifest` referenziert:

| Datei                   | Größe    | Zweck                                               |
| ----------------------- | -------- | --------------------------------------------------- |
| `icon.svg`              | beliebig | Vektor-Icon (`purpose: any`)                        |
| `icon-192.png`          | 192×192  | Homescreen/Installationsdialog                      |
| `icon-512.png`          | 512×512  | Splash/Store-Listing                                |
| `icon-512-maskable.png` | 512×512  | Maskable (Inhalt in der inneren Safe-Zone von 80 %) |

Beim Austausch: gleiche Dateinamen beibehalten, danach `SW_VERSION` in
`../sw.js` hochzählen, damit die alten Icons aus dem Cache fallen.
