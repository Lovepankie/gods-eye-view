// Server-side resolver for shortened Google Maps links (maps.app.goo.gl,
// goo.gl/maps, g.co). The browser cannot follow those redirects itself
// (opaque cross-origin), so the client posts the URL here; we follow the
// redirect chain, then pull lat/lng out of the resolved URL or page body.
//
// SSRF hardening: only Google-owned link hosts are fetched, http(s) only.

import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { readResponseTextCapped } from './common/http.js';

const RATE = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 120 });

// Google interstitials (consent pages) can be large; the coords we want sit in
// the URL or early markup, so a modest cap is plenty.
const MAX_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';

// Only ever fetch Google-owned short-link / maps hosts.
function hostAllowed(host) {
  const h = String(host || '').toLowerCase();
  if (h === 'goo.gl' || h === 'maps.app.goo.gl' || h === 'g.co') return true;
  // google.<tld>, www.google.<tld>, maps.google.<tld>, consent.google.<tld>
  return /^(?:www\.|maps\.|consent\.)?google\.[a-z.]+$/.test(h);
}

function extractLatLng(text) {
  if (!text) return null;
  const variants = [text];
  try {
    const decoded = decodeURIComponent(text);
    if (decoded !== text) variants.push(decoded);
  } catch {
    /* ignore malformed escape */
  }
  const patterns = [
    new RegExp(`@${NUM},${NUM}`),
    new RegExp(`!3d${NUM}!4d${NUM}`),
    new RegExp(`[?&](?:q|query|ll|sll|destination|center|daddr|saddr)=${NUM},${NUM}`, 'i'),
    new RegExp(`/(?:search|dir|place)/${NUM},${NUM}`),
  ];
  for (const v of variants) {
    for (const re of patterns) {
      const m = v.match(re);
      if (m) {
        const lat = parseFloat(m[1]);
        const lng = parseFloat(m[2]);
        if (
          Number.isFinite(lat) &&
          Number.isFinite(lng) &&
          Math.abs(lat) <= 90 &&
          Math.abs(lng) <= 180
        ) {
          return { lat, lng };
        }
      }
    }
  }
  return null;
}

export function mapsLinkProxy() {
  return {
    name: 'gev-maps-link-proxy',
    configureServer(server) {
      // GET /api/resolve-maps-link?url=<encoded google maps url>
      server.middlewares.use('/api/resolve-maps-link', async (req, res) => {
        const send = (obj, code = 200) => {
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        try {
          if (!RATE(clientKey(req))) return send({ ok: false, error: 'rate limited' }, 429);

          const reqUrl = new URL(req.url, 'http://localhost');
          const target = reqUrl.searchParams.get('url');
          if (!target) return send({ ok: false, error: 'missing url' });

          let u;
          try {
            u = new URL(target);
          } catch {
            return send({ ok: false, error: 'invalid url' });
          }
          if (u.protocol !== 'https:' && u.protocol !== 'http:') {
            return send({ ok: false, error: 'bad protocol' });
          }
          if (!hostAllowed(u.hostname)) {
            return send({ ok: false, error: 'host not allowed' });
          }

          // Coordinates may already be in the supplied URL (full maps link).
          let hit = extractLatLng(target);

          if (!hit) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
            try {
              const upstream = await fetch(target, {
                redirect: 'follow',
                signal: controller.signal,
                headers: {
                  'User-Agent': 'Mozilla/5.0 (gods-eye-view local resolver)',
                  'Accept-Language': 'en',
                },
              });
              // Guard against a redirect that escaped the Google host allowlist.
              try {
                const finalHost = new URL(upstream.url).hostname;
                if (!hostAllowed(finalHost)) {
                  return send({ ok: false, error: 'redirected off-allowlist' });
                }
              } catch {
                /* upstream.url unparseable — fall through to body scan */
              }
              hit = extractLatLng(upstream.url);
              if (!hit) {
                const body = await readResponseTextCapped(upstream, MAX_BYTES);
                hit = extractLatLng(body);
              }
            } finally {
              clearTimeout(timer);
            }
          }

          if (!hit) return send({ ok: false, error: 'no coordinates found' });
          return send({ ok: true, lat: hit.lat, lng: hit.lng });
        } catch (e) {
          console.error('[MapsLink Proxy]', e?.message || e);
          return send({ ok: false, error: 'resolve error' });
        }
      });
    },
  };
}
