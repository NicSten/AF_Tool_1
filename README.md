# AF Field

Offline-first PWA for arc flash field data collection on Android tablets
(Chrome, active stylus). Projects hold one-line PDFs; you mark them up with the pen.

- **All data stays on the tablet** (IndexedDB). No server, no login, no network needed after the first load.
- **Pen draws, fingers pan and pinch-zoom.** Touches are ignored while the pen is down (palm rejection).
  The pen's eraser end or barrel button erases. Double-tap toggles fit / close-up.
- **Ink is stored as vectors** per page, in PDF points: 3 colours, stroke eraser, undo/redo, hide/show.
- Large sheets stay sharp at any zoom: only the visible region is rendered at full resolution.

## Device pins

- **Long-press with the pen** anywhere on a sheet to open the radial menu. Slide to a type
  (Breaker, Fuse, Cable, Panel, Transformer, Other), then out to a preset, and lift to drop the
  pin. Lifting without sliding keeps the menu open so the type and preset can be tapped instead.
- Pins get the next free tag for their type (`BKR-001`, `CBL-001`, …). Tap a pin to edit the tag,
  fields, notes and photos; drag it with the pen to move it.
- **Photos** are taken with the in-app camera, compressed to JPEG (1600 px long side) and named
  by tag: `BKR-001_01.jpg`.
- **Lasso** (toolbar): loop ink with the pen, then tap a pin to attach it.
- **Devices** lists every pin in the project, filterable by type, and flags empty fields. Tapping
  a row jumps to the pin. "Add device" records equipment that is not on any drawing.
- **Presets** (projects screen): add, edit and delete presets and their fields for each type.

## Export and backup

Both are on the project screen and save a ZIP to the tablet's Downloads folder.

- **Export**: `csv/<Type>.csv` (tag, drawing, page, preset, all fields, notes, photo file names),
  `photos/<tag>_NN.jpg`, and `pdf/<drawing>_annotated.pdf` with the ink and pin tags drawn on the
  original pages plus a photo index at the end.
- **Back up**: one ZIP with everything (PDFs, ink, pins, photos, presets). **Restore** on the
  projects screen rebuilds the project from it, on this or another tablet.
- A project with changes that are not in a backup, and no backup made today, shows a warning.

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
    js/app.js                 projects, drawings, device list, preset manager, routing
    js/viewer.js              PDF viewer, pen/touch input, ink layer, pins, lasso
    js/radial.js              radial menu for dropping pins
    js/pins.js                pin detail sheet and camera
    js/exporter.js            export ZIP, annotated PDF, backup / restore
    js/db.js                  IndexedDB storage
    js/types.js               device types and default presets
    js/pdf.js, js/ui.js       pdf.js wrapper, shared dialogs and toast
    vendor/pdfjs/             pdf.js 6.5.438 (Apache-2.0), served locally for offline use
    vendor/pdf-lib/           pdf-lib 1.17.1 (MIT), writes the annotated PDFs
    vendor/fflate/            fflate 0.8.3 (MIT), reads and writes ZIP files
    sw.js                     generated service worker

## Note

Data lives only in Chrome's storage on that tablet: clearing site data or uninstalling
Chrome deletes it. Back up projects and move the ZIPs off the tablet.
