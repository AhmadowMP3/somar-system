import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, useScope } from '@/app/auth';
import { Badge, Button } from '@/components/ui/primitives';
import { EmptyState, ListSkeleton } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { supabase, unwrap } from '@/lib/supabase';

export type Named = { id: string; name: string; is_active: boolean };
export type PackageRow = {
  id: string;
  university_id: string;
  name: string;
  trips_per_week: number;
  price: number | null;
  semester_start: string;
  semester_end: string;
  is_active: boolean;
};

export function useIsAdmin(): boolean {
  const { me } = useAuth();
  return me?.profile?.role === 'admin';
}

/** Renders children only once a university is selected (admins pick one in the header). */
export function WithUniversity({ children }: { children: (universityId: string) => ReactNode }) {
  const { universityId, loading, isAdmin } = useScope();
  if (loading) return <ListSkeleton />;
  if (!universityId) {
    return (
      <EmptyState
        title={isAdmin ? t.university.noneYet : t.university.pickFirst}
        action={
          isAdmin ? (
            <Button asChild variant="secondary">
              <Link to="/admin/universities">{t.university.add}</Link>
            </Button>
          ) : undefined
        }
      />
    );
  }
  return <>{children(universityId)}</>;
}

export function useColleges(universityId: string | null | undefined) {
  return useQuery({
    queryKey: ['colleges', universityId],
    enabled: Boolean(universityId),
    queryFn: async () =>
      unwrap(
        await supabase.from('colleges').select('id, name, is_active').eq('university_id', universityId as string).order('name'),
      ) as Named[],
  });
}

export function useAreas(universityId: string | null | undefined) {
  return useQuery({
    queryKey: ['areas', universityId],
    enabled: Boolean(universityId),
    queryFn: async () =>
      unwrap(
        await supabase.from('areas').select('id, name, is_active').eq('university_id', universityId as string).order('name'),
      ) as Named[],
  });
}

export function usePackages(universityId: string | null | undefined) {
  return useQuery({
    queryKey: ['packages', universityId],
    enabled: Boolean(universityId),
    queryFn: async () =>
      unwrap(
        await supabase
          .from('packages')
          .select('id, university_id, name, trips_per_week, price, semester_start, semester_end, is_active')
          .eq('university_id', universityId as string)
          .order('trips_per_week'),
      ) as PackageRow[],
  });
}

export function ActiveBadge({ active }: { active: boolean }) {
  return <Badge tone={active ? 'success' : 'neutral'}>{active ? t.common.active : t.common.inactive}</Badge>;
}

export const WEEK_DAYS = [6, 7, 1, 2, 3, 4, 5];

export function DayToggles({ value, onChange }: { value: number[]; onChange: (days: number[]) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {WEEK_DAYS.map((d) => {
        const on = value.includes(d);
        return (
          <button
            key={d}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== d) : [...value, d].sort((a, b) => a - b))}
            className={
              on
                ? 'min-h-touch rounded-lg bg-brand-ink px-3 text-sm font-semibold text-white'
                : 'min-h-touch rounded-lg border border-border px-3 text-sm'
            }
          >
            {t.days[d]}
          </button>
        );
      })}
    </div>
  );
}
