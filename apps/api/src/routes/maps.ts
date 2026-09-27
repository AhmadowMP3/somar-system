import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../lib/audit.js';
import { assertPermission, assertUniversityScope, authOf, clientIp, type AppContext } from '../lib/auth.js';
import { ApiError, forbidden, notFound } from '../lib/errors.js';
import { resolveMapsLocation } from '../services/maps-links.js';

type Point = [number, number]; // [lat, lng]
type PathResult = { source: 'road' | 'straight'; points: Point[]; stops: number };

/** A path that fell back to straight lines is retried after this long. */
const STRAIGHT_RETRY_MS = 60 * 60 * 1000;

/** Road path from an OSRM-compatible service, or null when it is unreachable or has no route. */
async function roadPath(baseUrl: string, stops: Point[], userAgent: string): Promise<Point[] | null> {
  const coords = stops.map(([lat, lng]) => `${lng},${lat}`).join(';');
  const url = `${baseUrl.replace(/\/$/, '')}/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url, { headers: { 'user-agent': userAgent }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { code?: string; routes?: { geometry?: { coordinates?: [number, number][] } }[] };
    const line = body.code === 'Ok' ? body.routes?.[0]?.geometry?.coordinates : undefined;
    if (!line || line.length < 2) return null;
    return line.map(([lng, lat]) => [lat, lng]);
  } catch {
    return null;
  }
}

export async function mapRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, cfg, requireRole } = ctx;
  const anyUser = requireRole();
  const staff = requireRole('admin', 'university_supervisor');

  /** Centre of a university's located stops: the reference that completes short Plus Codes. */
  const cityCentre = async (universityId: string) => {
    const { data } = await db.from('stops').select('lat, lng').eq('university_id', universityId).not('lat', 'is', null).not('lng', 'is', null);
    const pts = (data ?? []).map((r) => ({ lat: Number(r.lat), lng: Number(r.lng) }));
    if (!pts.length) return null;
    return { lat: pts.reduce((n, p) => n + p.lat, 0) / pts.length, lng: pts.reduce((n, p) => n + p.lng, 0) / pts.length };
  };

  /** Coordinates for one Google Maps link (share links are followed to the full address). */
  app.post('/api/maps/resolve', { preHandler: staff }, async (request) => {
    const auth = authOf(request);
    assertPermission(auth, 'routes');
    const body = z
      .object({ url: z.string().trim().min(5).max(2000), university_id: z.string().uuid().optional() })
      .parse(request.body);
    if (body.university_id) assertUniversityScope(auth, body.university_id);
    const reference = body.university_id ? await cityCentre(body.university_id) : null;
    const found = await resolveMapsLocation(body.url, { reference });
    if (!found) throw new ApiError(422, 'COORDS_NOT_FOUND');
    return { lat: found.lat, lng: found.lng };
  });

  /**
   * Fills in the coordinates of every stop of a university that has a link but no location yet.
   * Two passes: links that lead to coordinates first; then short Plus Codes, completed from the
   * centre of all the stops located so far (they only name a spot within the same city).
   */
  app.post('/api/stops/resolve-missing', { preHandler: staff }, async (request) => {
    const auth = authOf(request);
    assertPermission(auth, 'routes');
    const { university_id } = z.object({ university_id: z.string().uuid() }).parse(request.body);
    assertUniversityScope(auth, university_id);
    const { data: stops, error } = await db
      .from('stops')
      .select('id, name, maps_url')
      .eq('university_id', university_id)
      .not('maps_url', 'is', null)
      .or('lat.is.null,lng.is.null');
    if (error) throw new ApiError(500, 'INTERNAL');
    let fixed = 0;
    const save = async (id: string, lat: number, lng: number) => {
      const { error: upErr } = await db.from('stops').update({ lat, lng }).eq('id', id);
      if (!upErr) fixed += 1;
      return !upErr;
    };
    let pending = stops ?? [];
    for (const pass of [1, 2]) {
      const reference = pass === 2 ? await cityCentre(university_id) : null;
      if (pass === 2 && !reference) break;
      const left: typeof pending = [];
      for (const stop of pending) {
        const found = await resolveMapsLocation(stop.maps_url as string, { reference });
        if (!found || !(await save(stop.id as string, found.lat, found.lng))) left.push(stop);
      }
      pending = left;
      if (!pending.length) break;
    }
    const failed = pending.map((s) => s.name as string);
    // the same link pasted into differently named stops puts them all on one spot: report it
    const { data: linked } = await db.from('stops').select('name, maps_url').eq('university_id', university_id).not('maps_url', 'is', null);
    const byLink = new Map<string, string[]>();
    for (const s of linked ?? []) byLink.set(s.maps_url as string, [...(byLink.get(s.maps_url as string) ?? []), (s.name as string).replace(/s+/g, ' ').trim()]);
    const shared = [...byLink.values()].map((names) => [...new Set(names)]).filter((names) => names.length > 1);
    await writeAudit(db, {
      actor: auth.profile.id,
      universityId: university_id,
      action: 'stops.resolve_locations',
      entity: 'stops',
      entityId: null,
      after: { checked: stops?.length ?? 0, fixed, failed, shared },
      ip: clientIp(request),
    });
    return { checked: stops?.length ?? 0, fixed, failed, shared };
  });
  // one computation per route+stops at a time, even when many phones open the map together
  const inFlight = new Map<string, Promise<PathResult>>();

  app.get<{ Params: { id: string } }>('/api/routes/:id/path', { preHandler: anyUser }, async (request) => {
    const auth = authOf(request);
    const id = z.string().uuid().safeParse(request.params.id);
    if (!id.success) throw notFound();

    const { data: route, error } = await db
      .from('routes')
      .select('id, university_id, route_stops(seq, lat, lng, stop:stops(lat, lng))')
      .eq('id', id.data)
      .maybeSingle();
    if (error) throw new ApiError(500, 'INTERNAL');
    if (!route) throw notFound();
    if (auth.profile.role !== 'admin' && auth.profile.university_id !== route.university_id) throw forbidden();

    type RawStop = { seq: number; lat: number | null; lng: number | null; stop: { lat: number | null; lng: number | null } | null };
    const stops: Point[] = ((route.route_stops ?? []) as unknown as RawStop[])
      .sort((a, b) => a.seq - b.seq)
      .map((s) => [s.stop?.lat ?? s.lat, s.stop?.lng ?? s.lng] as const)
      .filter((p): p is readonly [number, number] => p[0] != null && p[1] != null)
      .map(([lat, lng]) => [Number(lat), Number(lng)]);
    if (stops.length < 2) return { source: 'straight', points: stops, stops: stops.length } satisfies PathResult;

    const hash = createHash('sha1')
      .update(stops.map(([a, b]) => `${a.toFixed(6)},${b.toFixed(6)}`).join(';'))
      .digest('hex');
    const { data: cached } = await db
      .from('route_paths')
      .select('coords_hash, points, source, computed_at')
      .eq('route_id', route.id)
      .maybeSingle();
    const fresh =
      cached?.coords_hash === hash &&
      (cached.source === 'road' || !cfg.ROUTING_URL || Date.now() - new Date(cached.computed_at as string).getTime() < STRAIGHT_RETRY_MS);
    if (cached && fresh) return { source: cached.source, points: cached.points as Point[], stops: stops.length } satisfies PathResult;

    const key = `${route.id}:${hash}`;
    let job = inFlight.get(key);
    if (!job) {
      job = (async (): Promise<PathResult> => {
        const road = cfg.ROUTING_URL ? await roadPath(cfg.ROUTING_URL, stops, `SomarTransport/${cfg.version} (${cfg.APP_BASE_URL})`) : null;
        const result: PathResult = road ? { source: 'road', points: road, stops: stops.length } : { source: 'straight', points: stops, stops: stops.length };
        await db.from('route_paths').upsert({
          route_id: route.id,
          university_id: route.university_id,
          coords_hash: hash,
          points: result.points,
          source: result.source,
          computed_at: new Date().toISOString(),
        });
        return result;
      })().finally(() => inFlight.delete(key));
      inFlight.set(key, job);
    }
    return job;
  });
}
