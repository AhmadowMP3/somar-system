import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { accessToken, cfg, closeDb, createStaff, createStudent, createUniversity, destroyUniversity, service, signIn, type Fixture } from './helpers.js';

/** A stand-in for OSRM: returns a road with one bend between every pair of stops; can be told to fail. */
let requests = 0;
let failing = false;
let osrm: Server;
let app: FastifyInstance;
let fx: Fixture;
let other: Fixture;
let studentToken: string;
let foreignToken: string;
let routeId: string;
let stopIds: string[];

beforeAll(async () => {
  osrm = createServer((req, res) => {
    requests += 1;
    if (failing) {
      res.writeHead(503).end();
      return;
    }
    const coords = decodeURIComponent(req.url?.split('/driving/')[1]?.split('?')[0] ?? '')
      .split(';')
      .map((p) => p.split(',').map(Number) as [number, number]);
    const line: [number, number][] = [];
    coords.forEach((c, i) => {
      line.push(c);
      const next = coords[i + 1];
      if (next) line.push([(c[0] + next[0]) / 2 + 0.001, (c[1] + next[1]) / 2]);
    });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'Ok', routes: [{ geometry: { coordinates: line } }] }));
  });
  await new Promise<void>((resolve) => osrm.listen(0, '127.0.0.1', resolve));
  const port = (osrm.address() as AddressInfo).port;
  app = (await buildApp({ ...cfg, ROUTING_URL: `http://127.0.0.1:${port}` }, { logger: false })).app;

  fx = await createUniversity();
  other = await createUniversity();
  const st = await createStudent(fx);
  studentToken = await accessToken(await signIn(st.transportNumber, st.transportNumber));
  foreignToken = await accessToken((await createStaff(other, 'university_supervisor')).client);

  const { data: stops } = await service
    .from('stops')
    .insert([
      { university_id: fx.universityId, name: 'أ', lat: 36.2, lng: 37.1 },
      { university_id: fx.universityId, name: 'ب', lat: 36.21, lng: 37.12 },
      { university_id: fx.universityId, name: 'ج', lat: 36.22, lng: 37.14 },
      { university_id: fx.universityId, name: 'بلا موقع' },
    ])
    .select('id, name');
  const byName = new Map((stops ?? []).map((s) => [s.name as string, s.id as string]));
  stopIds = ['أ', 'ب', 'ج', 'بلا موقع'].map((n) => byName.get(n) as string);
  const { data: route } = await service
    .from('routes')
    .insert({ university_id: fx.universityId, name: 'خط الخريطة', direction: 'outbound', departure_time: '07:00' })
    .select('id')
    .single();
  routeId = route?.id as string;
  await service.from('route_stops').insert(
    [stopIds[0], stopIds[3], stopIds[1], stopIds[2]].map((stop_id, i) => ({ route_id: routeId, stop_id, seq: i + 1, departure_time: '07:00' })),
  );
});

afterAll(async () => {
  await app.close();
  osrm.close();
  await destroyUniversity(fx);
  await destroyUniversity(other);
  await closeDb();
});

const get = (token: string) => app.inject({ method: 'GET', url: `/api/routes/${routeId}/path`, headers: { authorization: `Bearer ${token}` } });

describe('route map path', () => {
  it('follows the road through the located stops in order, and is cached', async () => {
    const res = await get(studentToken);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { source: string; points: [number, number][]; stops: number };
    expect(body.source).toBe('road');
    expect(body.stops).toBe(3); // the stop without a location is skipped
    expect(body.points[0]).toEqual([36.2, 37.1]);
    expect(body.points.at(-1)).toEqual([36.22, 37.14]);
    expect(body.points).toHaveLength(5); // 3 stops + 2 bends
    expect(requests).toBe(1);

    await get(studentToken);
    expect(requests).toBe(1); // served from the cache
  });

  it('recomputes when the stops change, and falls back to straight lines when routing is down', async () => {
    failing = true;
    await service.from('route_stops').delete().eq('route_id', routeId).eq('stop_id', stopIds[1]);
    const res = await get(studentToken);
    const body = res.json() as { source: string; points: [number, number][] };
    expect(requests).toBe(2);
    expect(body).toEqual({ source: 'straight', points: [[36.2, 37.1], [36.22, 37.14]], stops: 2 });

    failing = false;
    await get(studentToken); // the straight fallback is only retried after an hour
    expect(requests).toBe(2);
  });

  it('is only for users of the route university', async () => {
    expect((await get(foreignToken)).statusCode).toBe(403);
    const res = await app.inject({ method: 'GET', url: `/api/routes/${routeId}/path` });
    expect(res.statusCode).toBe(401);
  });
});
