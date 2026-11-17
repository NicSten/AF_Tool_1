# Batch 3 — field quality acceptance plan

Before merging into deployed main, perform the following on the same Android model used for arc-flash surveys.

1. Deny camera permission or allow the prompt to remain open several seconds. After it fails, verify **Use camera app** is visible and opens the native camera chooser when tapped. Cancel and retry.
2. Capture a 400A breaker or MCC nameplate. Compare saved JPEG dimensions and readable characters against the 1600px legacy capture; try both native camera app and in-app ImageCapture path.
3. When device capabilities support it, toggle light and move zoom before capture, then verify the controls reset after closing. Unsupported controls must not appear.
4. Back up a sample project. Restore it successfully on a separate test profile/tablet and compare drawing count, pins, photos, ink and presets.
5. Try corrupted/invalid ZIPs (wrong JSON, duplicate IDs, missing PDF, bad image header). Every attempt must show a clear message and leave existing projects intact.
6. Export tags/cells beginning with = + - @ and verify Excel treats them as text. The CSV must preserve the entered characters, with the added text-escape apostrophe.
7. Export a diagram with tags \`Щит-01\`, \`断路器-01\`, and \`BKR-001\`, plus non-Latin project/drawing names. The visible labels should render rather than '?', while the drawing stays vector-based. Note that rendered Unicode overlays are not selectable text.
8. Test a rotated source PDF and confirm non-Latin pin labels appear at the correct coordinates; verify backup/export work offline after reloading the installed PWA.

Automated tests: \`npm install && npm run check && npm test\`; service-worker cache generation must also match \`tools/gen-sw.mjs\`.
