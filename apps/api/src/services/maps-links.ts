import { coordsFromMapsHtml, parseMapsUrl, type LatLng } from '@somar/shared';

/** Only Google Maps hosts are ever fetched (the server must not become a proxy to arbitrary addresses). */
export function isGoogleMapsHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'maps.app.goo.gl' || h === 'goo.gl' || h === 'g.co' || /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(h);
}

type Fetch = typeof fetch;
export type ResolveOptions = { fetch?: Fetch; isAllowedHost?: (host: string) => boolean; maxHops?: number; timeoutMs?: number };

const BROWSER_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

/** Google's consent interstitial carries the real address in `continue`. */
function unwrapConsent(url: URL): URL {
  if (url.hostname.startsWith('consent.')) {
    const next = url.searchParams.get('continue');
    if (next) {
      try {
        return new URL(next);
      } catch {
        /* keep the consent URL */
      }
    }
  }
  return url;
}

/**
 * Coordinates for a Google Maps link. Links with coordinates in them are read directly; share links
 * (maps.app.goo.gl …) are followed hop by hop to the full address, and as a last resort the final
 * Maps page is searched for its coordinates. Returns null when none can be found.
 */
export async function resolveMapsLocation(raw: string, opts: ResolveOptions = {}): Promise<(LatLng & { url: string }) | null> {
  const doFetch = opts.fetch ?? fetch;
  const allowed = opts.isAllowedHost ?? isGoogleMapsHost;
  const direct = parseMapsUrl(raw);
  if (direct) return { ...direct, url: raw };

  let current: URL;
  try {
    current = new URL(raw.trim());
  } catch {
    return null;
  }
  for (let hop = 0; hop < (opts.maxHops ?? 6); hop += 1) {
    current = unwrapConsent(current);
    const fromUrl = parseMapsUrl(current.toString());
    if (fromUrl) return { ...fromUrl, url: current.toString() };
    if (!['http:', 'https:'].includes(current.protocol) || !allowed(current.hostname)) return null;

    let res: Response;
    try {
      res = await doFetch(current, {
        redirect: 'manual',
        headers: { 'user-agent': BROWSER_UA, 'accept-language': 'ar,en;q=0.8' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      });
    } catch {
      return null;
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current);
      continue;
    }
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 3_000_000);
    const fromPage = coordsFromMapsHtml(html);
    return fromPage ? { ...fromPage, url: current.toString() } : null;
  }
  return null;
}
