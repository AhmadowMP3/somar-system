import { describe, expect, it } from 'vitest';
import { isGoogleMapsHost, resolveMapsLocation } from '../../src/services/maps-links.js';

/** A fake web: each URL answers with a redirect, a page, or an error. */
function fakeFetch(routes: Record<string, { status: number; location?: string; body?: string }>) {
  const calls: string[] = [];
  const impl = (async (input: URL | string) => {
    const url = String(input);
    calls.push(url);
    const r = routes[url];
    if (!r) return new Response('not found', { status: 404 });
    return new Response(r.body ?? '', { status: r.status, headers: r.location ? { location: r.location } : {} });
  }) as typeof fetch;
  return { impl, calls };
}

describe('Google Maps link resolution', () => {
  it('reads coordinates straight from a full link, without any request', async () => {
    const { impl, calls } = fakeFetch({});
    expect(await resolveMapsLocation('https://maps.google.com/?q=36.2021,37.1343', { fetch: impl })).toMatchObject({ lat: 36.2021, lng: 37.1343 });
    expect(calls).toEqual([]);
  });

  it('follows a share link to the full address', async () => {
    const { impl, calls } = fakeFetch({
      'https://maps.app.goo.gl/AbC123': { status: 302, location: 'https://www.google.com/maps/place/X/@36.3,37.3,17z/data=!3d36.2021!4d37.1343' },
    });
    const res = await resolveMapsLocation('https://maps.app.goo.gl/AbC123', { fetch: impl });
    expect(res).toMatchObject({ lat: 36.2021, lng: 37.1343 });
    expect(calls).toEqual(['https://maps.app.goo.gl/AbC123']);
  });

  it('passes the consent page and several hops, then reads the page when the address has no coordinates', async () => {
    const { impl } = fakeFetch({
      'https://maps.app.goo.gl/Zz': { status: 302, location: 'https://consent.google.com/ml?continue=https://maps.google.com/maps?cid%3D123' },
      'https://maps.google.com/maps?cid=123': { status: 301, location: '/maps/place/Somewhere' },
      'https://maps.google.com/maps/place/Somewhere': {
        status: 200,
        body: '<meta content="https://maps.google.com/maps/api/staticmap?center=36.1893%2C37.1561&amp;zoom=15">',
      },
    });
    expect(await resolveMapsLocation('https://maps.app.goo.gl/Zz', { fetch: impl })).toMatchObject({ lat: 36.1893, lng: 37.1561 });
  });

  it('completes a Plus Code share address (as Google sends for Aleppo stops) from the city reference', async () => {
    // real shape: …/maps?q=644M+8MW+<place name>  — the code's «+» and the spaces are both «+»
    const { impl } = fakeFetch({
      'https://maps.app.goo.gl/Plus': {
        status: 302,
        location: 'https://maps.google.com/?q=644M+8MW+%D8%A7%D8%AF%D9%88%D9%86%D9%8A%D8%B3%D8%8C+%D8%AD%D9%84%D8%A8&ftid=0x0:0x1',
      },
    });
    const aleppo = { lat: 36.2, lng: 37.13 };
    const res = await resolveMapsLocation('https://maps.app.goo.gl/Plus', { fetch: impl, reference: aleppo });
    expect(res?.lat).toBeCloseTo(36.20586, 4);
    expect(res?.lng).toBeCloseTo(37.1342, 3);
    // without a reference a short code cannot be placed
    expect(await resolveMapsLocation('https://maps.app.goo.gl/Plus', { fetch: impl })).toBeNull();
    // a Plus Code typed directly
    expect(await resolveMapsLocation('644M+8MW', { fetch: impl, reference: aleppo })).toMatchObject({ lat: res?.lat, lng: res?.lng });
  });

  it('never leaves Google, and gives up cleanly', async () => {
    const { impl, calls } = fakeFetch({ 'https://maps.app.goo.gl/evil': { status: 302, location: 'http://169.254.169.254/latest/meta-data' } });
    expect(await resolveMapsLocation('https://maps.app.goo.gl/evil', { fetch: impl })).toBeNull();
    expect(calls).toEqual(['https://maps.app.goo.gl/evil']);
    expect(await resolveMapsLocation('https://example.com/x', { fetch: impl })).toBeNull();
    expect(await resolveMapsLocation('not a link', { fetch: impl })).toBeNull();
    const loop = fakeFetch({ 'https://maps.app.goo.gl/loop': { status: 302, location: 'https://maps.app.goo.gl/loop' } });
    expect(await resolveMapsLocation('https://maps.app.goo.gl/loop', { fetch: loop.impl })).toBeNull();
    expect(loop.calls.length).toBe(6);
  });

  it('allows only Google Maps hosts', () => {
    for (const h of ['maps.app.goo.gl', 'goo.gl', 'www.google.com', 'maps.google.com', 'consent.google.com', 'www.google.com.sy', 'google.co.uk']) {
      expect(isGoogleMapsHost(h)).toBe(true);
    }
    for (const h of ['google.com.evil.io', 'evilgoogle.com', '127.0.0.1', 'localhost', 'goo.gl.evil.com']) {
      expect(isGoogleMapsHost(h)).toBe(false);
    }
  });
});
