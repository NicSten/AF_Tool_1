# Batch 2 QA checklist

Automated: npm install && npm run check && npm test.

Tablet checks before merge:
1. Open two AF Field tabs. Rapidly add 20 breakers; ensure unique sequential BKR tags across both tabs.
2. Try to rename two separate devices to the same tag with different capitalization; one save must be rejected.
3. Change a breaker type repeatedly while other devices are added; ensure the auto tag is unique.
4. Add three photos to tags that sanitize to identical filenames (A/1, A:1). Export and confirm ZIP photo entries, CSV cells and PDF photo index all refer to the distinct same names.
5. Lasso-attach ink to two breakers on one drawing; delete one breaker. The ink remains visible, but its obsolete attachment is cleared. Reopen the drawing.
6. Update the installed PWA. The old version must remain intact until the “Reload to update” button is used. Confirm offline mode still works after reload.
7. Test blocked IndexedDB open/version upgrades by running a second tab with an older installed version, then closing/reopening it.
