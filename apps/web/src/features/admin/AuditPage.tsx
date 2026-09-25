import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { damascusDate, addDays, formatDateTime } from '@somar/shared';
import { useScope } from '@/app/auth';
import { Badge, Card, Field, Input, Select } from '@/components/ui/primitives';
import { DataList, EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { supabase, unwrap } from '@/lib/supabase';

type AuditRow = {
  id: string;
  actor_profile_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
};

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return t.common.none;
  if (typeof v === 'boolean') return v ? t.common.yes : t.common.no;
  if (Array.isArray(v)) return v.map(formatValue).join(t.listSeparator);
  if (typeof v === 'object') return '…';
  const str = String(v);
  return t.admin.audit.values[str] ?? str;
}

/** Changed fields with Arabic labels; unknown technical columns are not shown. */
function diff(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string[] {
  const labels = t.admin.audit.fields;
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out: string[] = [];
  for (const k of keys) {
    const label = labels[k];
    if (!label) continue;
    const a = before?.[k];
    const b = after?.[k];
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    out.push(before && after ? `${label}: ${formatValue(a)} ← ${formatValue(b)}` : `${label}: ${formatValue(before ? a : b)}`);
  }
  return out.slice(0, 8);
}

export default function AuditPage() {
  const a = t.admin.audit;
  const { universityId, isAdmin } = useScope();
  const [from, setFrom] = useState(addDays(damascusDate(), -7));
  const [to, setTo] = useState(damascusDate());
  const [action, setAction] = useState('');
  const ids = { from: useId(), to: useId(), action: useId() };

  const actors = useQuery({
    queryKey: ['audit-actors'],
    queryFn: async () => unwrap(await supabase.from('profiles').select('id, full_name').limit(2000)) as { id: string; full_name: string }[],
  });
  const query = useQuery({
    queryKey: ['audit', universityId, from, to, action],
    queryFn: async () => {
      let q = supabase
        .from('audit_log')
        .select('id, actor_profile_id, action, entity, entity_id, before, after, ip, created_at')
        .gte('created_at', `${from}T00:00:00+03:00`)
        .lte('created_at', `${to}T23:59:59+03:00`)
        .order('created_at', { ascending: false })
        .limit(500);
      if (universityId && !isAdmin) q = q.eq('university_id', universityId);
      if (universityId && isAdmin) q = q.or(`university_id.eq.${universityId},university_id.is.null`);
      if (action) q = q.eq('action', action);
      return unwrap(await q) as AuditRow[];
    },
  });
  const actorName = (id: string | null) => (id ? actors.data?.find((x) => x.id === id)?.full_name ?? t.common.none : a.system);

  return (
    <div className="space-y-4">
      <PageHeader title={a.title} />
      <Card className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Field label={t.common.from} htmlFor={ids.from}>
          <Input id={ids.from} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={t.common.to} htmlFor={ids.to}>
          <Input id={ids.to} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label={a.actionFilter} htmlFor={ids.action}>
          <Select id={ids.action} value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">{t.common.all}</option>
            {Object.entries(a.actions).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
      </Card>
      <QueryState query={query} empty={(rows) => (rows.length ? null : <EmptyState title={a.empty} />)}>
        {(rows) => (
          <DataList
            rows={rows}
            rowKey={(r) => r.id}
            cardTitle={(r) => a.actions[r.action] ?? a.unknownAction}
            columns={[
              { key: 'time', header: t.common.time, cell: (r) => <span className="num">{formatDateTime(r.created_at)}</span> },
              { key: 'actor', header: a.actor, cell: (r) => actorName(r.actor_profile_id) },
              { key: 'action', header: a.action, cell: (r) => <Badge tone="info">{a.actions[r.action] ?? a.unknownAction}</Badge>, mobileHidden: true },
              {
                key: 'changes',
                header: a.changes,
                cell: (r) => (
                  <ul className="max-w-md space-y-0.5 text-xs text-muted">
                    {diff(r.before, r.after).map((line) => (
                      <li key={line} className="truncate text-start">
                        {line}
                      </li>
                    ))}
                  </ul>
                ),
              },
            ]}
          />
        )}
      </QueryState>
    </div>
  );
}
