# AF Field

Offline-first PWA for arc flash field data collection on Android tablets
(Chrome, active stylus). Projects hold one-line PDFs; you mark them up with the pen.

- **All data stays on the tablet** (IndexedDB). No server, no login, no network needed after the first load.
- **Pen draws, fingers pan and pinch-zoom.** Touches are ignored while the pen is down (palm rejection).
  The pen's eraser end or barrel button erases. Double-tap toggles fit / close-up.
- **Ink is stored as vectors** per page, in PDF points: 3 colours, stroke eraser, undo/redo, hide/show.
- Large sheets stay sharp at any zoom: only the visible region is rendered at full resolution.

## Deploy to GitHub Pages

There is no build step. In the repository: **Settings → Pages → Deploy from a branch**,
pick the branch and `/ (root)`. Open the Pages URL once on each tablet while online, then
use Chrome's **Install app / Add to Home screen**. Installing also lets Android protect the
stored data from automatic cleanup.

## Development

    python3 -m http.server 8765      # then open http://localhost:8765/
    node tools/gen-sw.mjs            # run after changing any file, before committing

`gen-sw.mjs` rewrites `sw.js` with the list of files to cache for offline use.
A mouse works for testing: left button draws, right/middle button drags, wheel zooms.

## Layout

    index.html, css/app.css   screens and styles
    js/app.js                 projects, drawings, PDF import, routing
    js/viewer.js              PDF viewer, pen/touch input, ink layer
    js/db.js                  IndexedDB storage
    js/pdf.js                 pdf.js wrapper
    vendor/pdfjs/             pdf.js 6.5.438 (Apache-2.0), served locally for offline use
    sw.js                     generated service worker

## Note

Data lives only in Chrome's storage on that tablet: clearing site data or uninstalling
Chrome deletes it, and there is currently no export.
