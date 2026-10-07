import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, useScope } from '@/app/auth';
import { Badge, Button } from '@/components/ui/primitives';
import { EmptyState, ListSkeleton } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { exportSheet } from '@/lib/exportSheet';
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

export type StopOption = { id: string; name: string; areas: { name: string } | null };

/** Active library stops of a university, for «nearest stop» dropdowns. */
export function useStopOptions(universityId: string | null | undefined) {
  return useQuery({
    queryKey: ['stop-options', universityId],
    enabled: Boolean(universityId),
    queryFn: async () =>
      unwrap(
        await supabase
          .from('stops')
          .select('id, name, areas(name)')
          .eq('university_id', universityId as string)
          .eq('is_active', true)
          .order('name'),
      ) as unknown as StopOption[],
  });
}

/** «دوار الشفاء — الحمدانية» */
export const stopLabel = (s: StopOption) => (s.areas?.name && s.areas.name !== s.name ? `${s.name} — ${s.areas.name}` : s.name);

export type RiderKind = 'student' | 'doctor' | 'employee';

/** Every rider of one kind with name and transport number (paged: the API returns at most 1000 rows). */
export async function fetchRiderNames(universityId: string, kind: RiderKind) {
  const all: { full_name: string; transport_number: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const page = unwrap(
      await supabase
        .from('students')
        .select('full_name, transport_number')
        .eq('university_id', universityId)
        .eq('kind', kind)
        .order('transport_number')
        .range(from, from + 999),
    ) as { full_name: string; transport_number: string }[];
    all.push(...page);
    if (page.length < 1000) break;
  }
  return all;
}

/** The names and transport numbers as an Excel file. */
export async function exportNamesAndNumbers(universityId: string, kind: RiderKind, fileName: string) {
  const all = await fetchRiderNames(universityId, kind);
  exportSheet(fileName, all.map((r) => ({ [t.common.name]: r.full_name, [t.student.transportNumber]: r.transport_number })));
  return all.length;
}

export function ActiveBadge({ active }: { active: boolean }) {
  return <Badge tone={active ? 'success' : 'neutral'}>{active ? t.common.active : t.common.inactive}</Badge>;
}

export const WEEK_DAYS = [6, 7, 1, 2, 3, 4, 5];

export function DayToggles({ value, onChange }: { value: number[]; onChange: (days: number[]) => void }) {
  return (
    <div className="flex flex-wrap gap-3">
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
                ? 'min-h-touch rounded-lg bg-brand-ink px-3 text-sm font-semibold text-on-ink'
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

type ImportStatus = 'created' | 'updated' | 'duplicate' | 'rejected';
type PickableRow = { row_number: number; status: ImportStatus };

/** Rejected rows cannot be imported; a duplicate can be ticked to keep that copy instead of the first. */
export const isPickable = (row: PickableRow) => row.status !== 'rejected';

/** The ticks an import preview starts with: everyone importable except in-file duplicates. */
export const defaultPicks = (rows: PickableRow[]) =>
  new Set(rows.filter((r) => r.status === 'created' || r.status === 'updated').map((r) => r.row_number));

/** The reviewer's ticks over an import preview. */
export function ImportPickBar({
  rows,
  picked,
  onChange,
}: {
  rows: PickableRow[];
  picked: Set<number>;
  onChange: (next: Set<number>) => void;
}) {
  const im = t.admin.import;
  const pickable = rows.filter(isPickable);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg p-3 text-sm" data-testid="import-pick-bar">
      <span>
        <span className="block font-bold num">{im.picked(picked.size, pickable.length)}</span>
        <span className="text-xs text-muted">{im.pickHint}</span>
      </span>
      <span className="flex gap-2">
        <Button size="sm" onClick={() => onChange(new Set(pickable.map((r) => r.row_number)))} data-testid="import-pick-all">
          {im.pickAll}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onChange(new Set())} data-testid="import-pick-none">
          {im.pickNone}
        </Button>
      </span>
    </div>
  );
}

export function ImportPickBox({
  row,
  name,
  picked,
  onChange,
}: {
  row: PickableRow;
  name: string;
  picked: Set<number>;
  onChange: (next: Set<number>) => void;
}) {
  if (!isPickable(row)) return null;
  const on = picked.has(row.row_number);
  return (
    <input
      type="checkbox"
      className="h-5 w-5 accent-brand-ink"
      checked={on}
      aria-label={t.admin.import.pickRow(name)}
      onChange={() => {
        const next = new Set(picked);
        if (on) next.delete(row.row_number);
        else next.add(row.row_number);
        onChange(next);
      }}
      data-testid={`import-pick-${row.row_number}`}
    />
  );
}
