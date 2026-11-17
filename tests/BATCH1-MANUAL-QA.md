# Batch 1 acceptance checklist

Automated checks: `npm install && npm run check && npm test`.

Tablet/browser acceptance before merging:
1. Add PDFs and photos. Backup with a native file picker, verify ZIP exists, then check the warning is cleared.
2. On Android, use **Share / Save to…**, cancel, and confirm warning remains. Share to cloud storage, verify the ZIP exists, and explicitly confirm.
3. Start a Downloads backup, cancel verification and confirm warning persists. Confirm only after checking the ZIP exists.
4. After a verified morning backup, modify a pin the same afternoon: warning must return.
5. Under storage pressure attempt replacement restore. An abort must preserve original PDFs, pins, ink, photos and project.
6. Restore a good ZIP with PDFs, photos and annotations; inspect complete round trip.
7. Test photo-heavy backups on the tablet. Streaming bounds archive memory on browsers with native picker or OPFS; PDF/JPEG processing still uses memory for one file.
8. Confirm the service-worker update path before rollout; atomic service worker updates are queued separately.
