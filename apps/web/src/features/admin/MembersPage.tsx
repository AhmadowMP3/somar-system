import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSpreadsheet, Plus, Printer, Search } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { ImportSummary, MemberKind } from '@somar/shared';
import { Dialog } from '@/components/ui/overlay';
import { Badge, Button, Field, Input, Select } from '@/components/ui/primitives';
import { DataList, EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { supabase, unwrap } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { ActiveBadge, WEEK_DAYS, WithUniversity } from './common';

type MemberRow = {
  student_id: string;
  transport_number: string;
  full_name: string;
  phone_e164: string | null;
  job_title: string | null;
  residence_text: string | null;
  work_days: number[];
  has_photo: boolean;
  is_active: boolean;
  profile_role: string | null;
};

/** Base path of a member's pages in the admin panel. */
export const memberPath = (kind: MemberKind) => (kind === 'doctor' ? '/admin/doctors' : '/admin/employees');

export default function MembersPage({ kind }: { kind: MemberKind }) {
  return <WithUniversity>{(universityId) => <MembersBody key={`${kind}-${universityId}`} kind={kind} universityId={universityId} />}</WithUniversity>;
}

const FILTER_KEYS = ['q', 'day', 'photo', 'active'] as const;

function MembersBody({ kind, universityId }: { kind: MemberKind; universityId: string }) {
  const m = t.admin.members;
  const k = m[kind];
  const f = t.admin.students.filters;
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [importOpen, setImportOpen] = useState(false);
  const searchId = useId();
  const filters = Object.fromEntries(FILTER_KEYS.map((key) => [key, params.get(key) ?? ''])) as Record<(typeof FILTER_KEYS)[number], string>;

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const query = useQuery({
    queryKey: ['students', 'members', kind, universityId, filters],
    queryFn: async () => {
      let q = supabase
        .from('v_rider_balance')
        .select('student_id, transport_number, full_name, phone_e164, job_title, residence_text, work_days, has_photo, is_active, profile_role', {
          count: 'exact',
        })
        .eq('university_id', universityId)
        .eq('kind', kind)
        .order('transport_number')
        .limit(500);
      if (filters.q) {
        const term = filters.q.replace(/[,()]/g, ' ').trim();
        q = q.or(`full_name.ilike.%${term}%,transport_number.ilike.%${term}%,phone_e164.ilike.%${term}%,job_title.ilike.%${term}%`);
      }
      if (filters.day) q = q.contains('work_days', [Number(filters.day)]);
      if (filters.photo === 'yes') q = q.eq('has_photo', true);
      if (filters.photo === 'no') q = q.eq('has_photo', false);
      if (filters.active === 'yes') q = q.eq('is_active', true);
      if (filters.active === 'no') q = q.eq('is_active', false);
      const res = await q;
      return { rows: unwrap(res) as MemberRow[], count: res.count ?? 0 };
    },
  });

  const printHref = useMemo(() => {
    const rows = query.data?.rows ?? [];
    if (rows.length && rows.length <= 60) return `/admin/cards?ids=${rows.map((r) => r.student_id).join(',')}`;
    return `/admin/cards?university=${universityId}&kind=${kind}`;
  }, [query.data, universityId, kind]);

  return (
    <div>
      <PageHeader
        title={k.title}
        subtitle={query.data ? k.count(query.data.count) : undefined}
        actions={
          <>
            <Button asChild>
              <Link to={printHref}>
                <Printer className="h-4 w-4" aria-hidden />
                {t.admin.students.printCards}
              </Link>
            </Button>
            <Button onClick={() => setImportOpen(true)} data-testid="member-import">
              <FileSpreadsheet className="h-4 w-4" aria-hidden />
              {m.import}
            </Button>
            <Button asChild variant="secondary">
              <Link to={`${memberPath(kind)}/new`}>
                <Plus className="h-4 w-4" aria-hidden />
                {k.add}
              </Link>
            </Button>
          </>
        }
      />
      <p className="mb-3 text-sm text-muted">{m.unlimitedNote}</p>
      <div className="mb-4 space-y-3 rounded-xl border border-border bg-bg p-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter('q', search.trim());
          }}
        >
          <label htmlFor={searchId} className="sr-only">
            {t.common.search}
          </label>
          <Input id={searchId} placeholder={t.common.searchPlaceholder} value={search} onChange={(e) => setSearch(e.target.value)} />
          <Button type="submit" variant="secondary" aria-label={t.common.search}>
            <Search className="h-4 w-4" />
          </Button>
        </form>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
          <Select aria-label={f.workDay} value={filters.day} onChange={(e) => setFilter('day', e.target.value)}>
            <option value="">{f.workDay}: {t.common.all}</option>
            {WEEK_DAYS.map((d) => (
              <option key={d} value={d}>
                {t.days[d]}
              </option>
            ))}
          </Select>
          <Select aria-label={f.photo} value={filters.photo} onChange={(e) => setFilter('photo', e.target.value)}>
            <option value="">{f.photo}: {t.common.all}</option>
            <option value="yes">{f.hasPhoto}</option>
            <option value="no">{f.noPhoto}</option>
          </Select>
          <Select aria-label={f.active} value={filters.active} onChange={(e) => setFilter('active', e.target.value)}>
            <option value="">{f.active}: {t.common.all}</option>
            <option value="yes">{t.common.active}</option>
            <option value="no">{t.common.inactive}</option>
          </Select>
        </div>
      </div>
      <QueryState query={query} empty={(d) => (d.rows.length ? null : <EmptyState title={k.empty} hint={k.emptyHint} />)}>
        {(d) => (
          <DataList
            rows={d.rows}
            rowKey={(r) => r.student_id}
            onRowClick={(r) => navigate(`${memberPath(kind)}/${r.student_id}`)}
            cardTitle={(r) => (
              <span className="flex items-center justify-between gap-2">
                <span>{r.full_name}</span>
                <span className="num font-mono text-sm text-brand-ink">{r.transport_number}</span>
              </span>
            )}
            columns={[
              { key: 'tn', header: t.student.transportNumber, cell: (r) => <span className="num font-mono">{r.transport_number}</span>, mobileHidden: true },
              {
                key: 'name',
                header: t.common.name,
                mobileHidden: true,
                cell: (r) => (
                  <span className="flex flex-wrap items-center gap-1">
                    {r.full_name}
                    {r.profile_role === 'supervisor' ? <Badge tone="info">{t.admin.students.isSupervisor}</Badge> : null}
                  </span>
                ),
              },
              { key: 'job', header: t.student.jobTitle, cell: (r) => r.job_title ?? t.common.none },
              {
                key: 'days',
                header: t.student.workDays,
                cell: (r) => (r.work_days.length ? r.work_days.map((x) => t.days[x]).join(t.listSeparator) : t.common.none),
              },
              { key: 'trips', header: t.student.remainingShort, cell: () => <Badge tone="success">{m.unlimited}</Badge> },
              { key: 'photo', header: t.student.photo, cell: (r) => (r.has_photo ? <Badge tone="success">✓</Badge> : <Badge>{f.noPhoto}</Badge>) },
              { key: 'status', header: t.common.status, cell: (r) => <ActiveBadge active={r.is_active} /> },
            ]}
          />
        )}
      </QueryState>
      {importOpen ? <ImportDialog kind={kind} universityId={universityId} onClose={() => setImportOpen(false)} /> : null}
    </div>
  );
}

type ImportRow = { row_number: number; status: 'created' | 'updated' | 'duplicate' | 'rejected'; full_name: string; reasons: string[]; warnings: string[] };
type ImportResponse = { summary: ImportSummary; rows: ImportRow[]; dry_run: boolean };

const STATUS_TONE = { created: 'success', updated: 'info', duplicate: 'neutral', rejected: 'danger' } as const;

/** Upload → preview (nothing written) → confirm. */
function ImportDialog({ kind, universityId, onClose }: { kind: MemberKind; universityId: string; onClose: () => void }) {
  const m = t.admin.members;
  const im = t.admin.import;
  const qc = useQueryClient();
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [res, setRes] = useState<ImportResponse | null>(null);
  const [filter, setFilter] = useState('');

  const call = useMutation({
    mutationFn: (dryRun: boolean) => {
      const form = new FormData();
      form.append('university_id', universityId);
      form.append('kind', kind);
      form.append('dry_run', String(dryRun));
      form.append('file', file as File);
      return api.post<ImportResponse>('/members/import', form);
    },
    onSuccess: (data) => {
      setRes(data);
      setFilter('');
      if (!data.dry_run) void qc.invalidateQueries({ queryKey: ['students'] });
    },
  });

  const done = res && !res.dry_run;
  const rows = (res?.rows ?? []).filter((r) => !filter || r.status === filter);
  const counters = [
    ['', im.counters.total, res?.summary.total],
    ['created', im.counters.created, res?.summary.created],
    ['updated', im.counters.updated, res?.summary.updated],
    ['duplicate', im.counters.duplicates, res?.summary.duplicates],
    ['rejected', im.counters.rejected, res?.summary.rejected],
  ] as const;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={m[kind].importTitle}
      description={m.importHint}
      className="sm:max-w-3xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {done ? t.common.close : t.common.cancel}
          </Button>
          {!res ? (
            <Button variant="secondary" disabled={!file || call.isPending} onClick={() => call.mutate(true)} data-testid="member-import-analyze">
              {call.isPending ? im.analyzing : im.preview}
            </Button>
          ) : !done ? (
            <Button variant="primary" disabled={call.isPending || res.summary.accepted === 0} onClick={() => call.mutate(false)} data-testid="member-import-commit">
              {call.isPending ? im.committing : im.commit}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-4">
        {!res ? (
          <Field label={im.upload} htmlFor={fileId}>
            <Input
              id={fileId}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              data-testid="member-import-file"
            />
          </Field>
        ) : null}
        {call.error ? (
          <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm font-semibold text-danger">
            {errorMessage(call.error)}
          </p>
        ) : null}
        {done ? <p className="rounded-xl bg-success/10 p-3 text-sm font-semibold text-success">{im.resultTitle}</p> : null}
        {res ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {counters.map(([status, label, value]) => (
                <button
                  key={label}
                  type="button"
                  aria-pressed={filter === status}
                  onClick={() => setFilter(status)}
                  className={cn('rounded-xl border p-2 text-start', filter === status ? 'border-brand-ink bg-brand-ink/5' : 'border-border bg-bg')}
                >
                  <span className="block text-xs text-muted">{label}</span>
                  <span className="num block text-xl font-extrabold">{value}</span>
                </button>
              ))}
            </div>
            <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-xl border border-border text-sm">
              {rows.map((r) => (
                <li key={r.row_number} className="flex items-start justify-between gap-2 p-2">
                  <span className="min-w-0">
                    <span className="num text-muted">{r.row_number}. </span>
                    {r.full_name || t.common.none}
                    {[...r.reasons, ...r.warnings].map((x) => (
                      <span key={x} className={cn('block text-xs', r.reasons.includes(x) ? 'text-danger' : 'text-warning')}>
                        {x}
                      </span>
                    ))}
                  </span>
                  <Badge tone={STATUS_TONE[r.status]}>{im.status[r.status]}</Badge>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
