// Allocate unique filename strings per exported photo. Sanitizing a device tag
// may collapse distinct tags (e.g. A/1 and A:1); resolve collisions once and
// reuse names across ZIP entries, CSV and PDF photo indexes.
export function uniquePhotoNames(pins, photosByPin, photoName) {
  const seen = new Set();
  const filenames = new Map();
  for (const pin of pins) {
    for (const photo of photosByPin.get(pin.id) || []) {
      const raw = photoName(pin, photo);
      const dot = raw.lastIndexOf('.');
      const base = dot < 0 ? raw : raw.slice(0, dot);
      const extension = dot < 0 ? '' : raw.slice(dot);
      let candidate = raw;
      let number = 2;
      while (seen.has(candidate.toLowerCase())) {
        candidate = base + ' (' + number++ + ')' + extension;
      }
      seen.add(candidate.toLowerCase());
      filenames.set(photo.id, candidate);
    }
  }
  return filenames;
}
