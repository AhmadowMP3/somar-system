import type { Session } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { loginCodeToEmail, type Role } from '@somar/shared';
import { config } from '@/lib/config';
import { supabase, unwrap } from '@/lib/supabase';
import { safeStorage } from '@/lib/pwa';

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

export type Me = {
  profile: Profile | null;
  student: { id: string; photo_path: string | null; university_id: string; transport_number: string } | null;
};

type AuthState = {
  session: Session | null;
  ready: boolean;
  me: Me | undefined;
  meLoading: boolean;
  meError: unknown;
  signIn: (code: string, password: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  refreshMe: () => Promise<unknown>;
  isStaff: boolean;
  canScan: boolean;
  isStudent: boolean;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    let mounted = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setReady(true);
    });
    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const uid = session?.user.id;
  const meQuery = useQuery({
    queryKey: ['me', uid],
    enabled: Boolean(uid),
    queryFn: async (): Promise<Me> => {
      const profile = unwrap(
        await supabase
          .from('profiles')
          .select('id, login_code, role, university_id, full_name, phone, is_active, must_change_password')
          .eq('id', uid as string)
          .maybeSingle<Profile>(),
      );
      const student = unwrap(
        await supabase
          .from('students')
          .select('id, photo_path, university_id, transport_number')
          .eq('profile_id', uid as string)
          .maybeSingle<Me['student'] & object>(),
      );
      return { profile, student };
    },
  });

  const signIn = useCallback(async (code: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email: loginCodeToEmail(code, config.emailDomain),
      password,
    });
    return !error;
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    qc.clear();
  }, [qc]);

  const value = useMemo<AuthState>(() => {
    const role = meQuery.data?.profile?.role;
    return {
      session,
      ready,
      me: meQuery.data,
      meLoading: meQuery.isLoading,
      meError: meQuery.error,
      signIn,
      signOut,
      refreshMe: () => meQuery.refetch(),
      isStaff: role === 'admin' || role === 'university_supervisor',
      canScan: role === 'admin' || role === 'university_supervisor' || role === 'supervisor',
      isStudent: Boolean(meQuery.data?.student),
    };
  }, [session, ready, meQuery, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

export type University = {
  id: string;
  name: string;
  logo_path: string | null;
  transport_prefix: string;
  transport_separator: '-' | '';
  week_start_dow: number;
  is_active: boolean;
};

type ScopeState = {
  universities: University[];
  universityId: string | null;
  university: University | null;
  setUniversityId: (id: string) => void;
  loading: boolean;
  isAdmin: boolean;
};

const ScopeContext = createContext<ScopeState | null>(null);
const SCOPE_KEY = 'somar.university';
const storage = safeStorage();

/** Selected university for staff screens. Admins pick; university supervisors are pinned to theirs. */
export function UniversityScopeProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const isAdmin = me?.profile?.role === 'admin';
  const [picked, setPicked] = useState<string | null>(() => storage.get(SCOPE_KEY));

  const query = useQuery({
    queryKey: ['universities'],
    enabled: Boolean(me?.profile),
    queryFn: async () =>
      unwrap(
        await supabase
          .from('universities')
          .select('id, name, logo_path, transport_prefix, transport_separator, week_start_dow, is_active')
          .order('name'),
      ) as University[],
  });

  const universities = useMemo(() => query.data ?? [], [query.data]);
  let universityId: string | null = null;
  if (!isAdmin) universityId = me?.profile?.university_id ?? null;
  else universityId = universities.find((u) => u.id === picked)?.id ?? universities[0]?.id ?? null;

  const value = useMemo<ScopeState>(
    () => ({
      universities,
      universityId,
      university: universities.find((u) => u.id === universityId) ?? null,
      setUniversityId: (id: string) => {
        setPicked(id);
        storage.set(SCOPE_KEY, id);
      },
      loading: query.isLoading,
      isAdmin,
    }),
    [universities, universityId, query.isLoading, isAdmin],
  );
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeState {
  const ctx = useContext(ScopeContext);
  if (!ctx) throw new Error('useScope outside UniversityScopeProvider');
  return ctx;
}
