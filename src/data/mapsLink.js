// Parse a latitude/longitude out of a pasted Google Maps link (or a raw
// "lat, lng" string) so the globe can fly straight to it. Full Google Maps
// URLs carry the coordinates in the URL itself, so those are parsed locally
// with zero network cost. Shortened links (maps.app.goo.gl, goo.gl/maps) hide
// the coordinates behind a redirect, so those are handed to the server-side
// /api/resolve-maps-link proxy which follows the redirect and extracts them.

// Latitude/longitude are up to 3 integer digits with an optional fraction.
const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';

function finiteLatLng(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

// Try the common Google Maps coordinate encodings in priority order. Runs the
// patterns against both the raw text and a URL-decoded copy so encoded commas
// (%2C) inside a `continue=`/`q=` parameter are still matched.
export function parseLatLngFromText(input) {
  if (!input) return null;
  const raw = String(input).trim();

  const variants = [raw];
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) variants.push(decoded);
  } catch {
    /* malformed escape sequence — ignore the decoded variant */
  }

  const patterns = [
    // Bare "lat, lng"
    new RegExp(`^${NUM}\\s*,\\s*${NUM}$`),
    // .../@lat,lng,15z/...  (camera anchor)
    new RegExp(`@${NUM},${NUM}`),
    // !3dlat!4dlng  (place data block)
    new RegExp(`!3d${NUM}!4d${NUM}`),
    // ?q=lat,lng  / query= / ll= / sll= / destination= / center= / daddr= / saddr=
    new RegExp(`[?&](?:q|query|ll|sll|destination|center|daddr|saddr)=${NUM},${NUM}`, 'i'),
    // /search/lat,lng  /dir/lat,lng  /place/lat,lng
    new RegExp(`/(?:search|dir|place)/${NUM},${NUM}`),
  ];

  for (const text of variants) {
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        const lat = parseFloat(m[1]);
        const lng = parseFloat(m[2]);
        if (finiteLatLng(lat, lng)) return { lat, lng };
      }
    }
  }
  return null;
}

// Resolve any pasted value to { lat, lng }. Local parse first (free); if that
// fails and the value is a URL, ask the server proxy to expand it.
export async function resolveMapsLink(input) {
  const local = parseLatLngFromText(input);
  if (local) return local;

  const s = String(input || '').trim();
  if (!/^https?:\/\//i.test(s)) return null; // not a URL, nothing to expand

  try {
    const res = await fetch(`/api/resolve-maps-link?url=${encodeURIComponent(s)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.ok && finiteLatLng(data.lat, data.lng)) {
      return { lat: data.lat, lng: data.lng, label: data.label };
    }
  } catch {
    /* offline or proxy error — fall through to null */
  }
  return null;
}
