import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@somar/shared';
import type { Config } from '../config.js';
import { ApiError, forbidden, unauthorized } from './errors.js';
import type { Db } from './supabase.js';

export type Profile = {
  id: string;
  login_code: string;
  role: Role;
  university_id: string | null;
  full_name: string;
  phone: string | null;
  is_active: boolean;
  must_change_password: boolean;
};

export type AuthContext = { token: string; profile: Profile };

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

export function makeAuthGuard(db: Db) {
  return function requireRole(...roles: Role[]) {
    return async (request: FastifyRequest, _reply: FastifyReply) => {
      const token = bearerToken(request);
      if (!token) throw unauthorized();
      const { data: userData, error } = await db.auth.getUser(token);
      if (error || !userData.user) throw unauthorized();
      const { data: profile, error: pErr } = await db
        .from('profiles')
        .select('id, login_code, role, university_id, full_name, phone, is_active, must_change_password')
        .eq('id', userData.user.id)
        .maybeSingle<Profile>();
      if (pErr) throw new ApiError(500, 'INTERNAL');
      if (!profile || !profile.is_active) throw forbidden();
      if (roles.length && !roles.includes(profile.role)) throw forbidden();
      request.auth = { token, profile };
    };
  };
}

export type RequireRole = ReturnType<typeof makeAuthGuard>;

export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

/** Admin: any university. University supervisor: only their own. */
export function assertUniversityScope(auth: AuthContext, universityId: string | null | undefined): void {
  if (auth.profile.role === 'admin') return;
  if (!universityId || auth.profile.university_id !== universityId) throw forbidden();
}

export function clientIp(request: FastifyRequest): string | null {
  const fwd = request.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
  return first?.trim() || request.ip || null;
}

export type AppContext = { cfg: Config; db: Db; requireRole: RequireRole };
