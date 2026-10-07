import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { useScope } from '@/app/auth';
import { useToast } from '@/components/ui/overlay';
import { Button, Card, Field, Input, Select, Switch } from '@/components/ui/primitives';
import { TimeInput12 } from '@/components/ui/TimeInput12';
import { PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { errorMessage } from '@/lib/errors';
import { supabase, unwrap } from '@/lib/supabase';
import { useIsAdmin } from './common';

type SettingsRow = {
  id: string;
  university_id: string | null;
  scan_cooldown_minutes: number;
  allow_offday_override: boolean;
  require_supervisor_geo: boolean;
  low_balance_threshold: number;
  expiry_warning_days: number;
  daily_job_hour: number;
  max_photo_mb: number;
  password_min_length: number;
  pickup_open_time: string;
  pickup_close_time: string;
};

const NUMERIC: { key: keyof SettingsRow; min: number; max: number }[] = [
  { key: 'scan_cooldown_minutes', min: 0, max: 240 },
  { key: 'low_balance_threshold', min: 0, max: 20 },
  { key: 'expiry_warning_days', min: 0, max: 90 },
  { key: 'daily_job_hour', min: 0, max: 23 },
  { key: 'max_photo_mb', min: 1, max: 50 },
  { key: 'password_min_length', min: 6, max: 64 },
];

export default function SettingsPage() {
  const s = t.admin.settings;
  const isAdmin = useIsAdmin();
  const { universityId, university } = useScope();
  const [scope, setScope] = useState<'global' | 'university'>(universityId ? 'university' : 'global');
  const [scopeTouched, setScopeTouched] = useState(false);
  // the selected university can load after this page mounts; follow it until the admin picks a scope
  useEffect(() => {
    if (!scopeTouched) setScope(universityId ? 'university' : 'global');
  }, [universityId, scopeTouched]);
  const scopeId = useId();
  const target = scope === 'global' ? null : universityId;

  const query = useQuery({
    queryKey: ['settings-rows', target],
    queryFn: async () => {
      let q = supabase.from('settings').select('*');
      q = target ? q.eq('university_id', target) : q.is('university_id', null);
      const own = unwrap(await q.maybeSingle()) as SettingsRow | null;
      if (own) return { row: own, inherited: false };
      const { data, error } = await supabase.rpc('get_settings', { p_university_id: target });
      if (error) throw error;
      return { row: data as SettingsRow, inherited: true };
    },
  });

  return (
    <div className="space-y-4">
      <PageHeader title={s.title} subtitle={isAdmin ? undefined : s.readOnly} />
      {isAdmin ? (
        <Card>
          <Field label={s.scope} htmlFor={scopeId}>
            <Select id={scopeId} value={scope} onChange={(e) => {
                setScopeTouched(true);
                setScope(e.target.value as typeof scope);
              }}
            >
              <option value="global">{s.global}</option>
              {universityId ? (
                <option value="university">
                  {s.universityScope}: {university?.name}
                </option>
              ) : null}
            </Select>
          </Field>
        </Card>
      ) : null}
      <QueryState query={query}>
        {(d) => <SettingsForm key={`${target}-${d.row.id}-${d.inherited}`} row={d.row} inherited={d.inherited} target={target} readOnly={!isAdmin} />}
      </QueryState>
    </div>
  );
}

function SettingsForm({ row, inherited, target, readOnly }: { row: SettingsRow; inherited: boolean; target: string | null; readOnly: boolean }) {
  const s = t.admin.settings;
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState(row);
  useEffect(() => setForm(row), [row]);
  const baseId = useId();
  const save = useMutation({
    mutationFn: async () => {
      const values = {
        scan_cooldown_minutes: Number(form.scan_cooldown_minutes),
        allow_offday_override: form.allow_offday_override,
        require_supervisor_geo: form.require_supervisor_geo,
        low_balance_threshold: Number(form.low_balance_threshold),
        expiry_warning_days: Number(form.expiry_warning_days),
        daily_job_hour: Number(form.daily_job_hour),
        max_photo_mb: Number(form.max_photo_mb),
        password_min_length: Number(form.password_min_length),
        pickup_open_time: form.pickup_open_time.slice(0, 5),
        pickup_close_time: form.pickup_close_time.slice(0, 5),
      };
      if (values.pickup_close_time <= values.pickup_open_time) throw new Error(s.pickupOrder);
      if (inherited) unwrap(await supabase.from('settings').insert({ ...values, university_id: target }));
      else unwrap(await supabase.from('settings').update(values).eq('id', row.id));
    },
    onSuccess: () => {
      toast.success(s.saved);
      void qc.invalidateQueries({ queryKey: ['settings-rows'] });
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e) => toast.error(e instanceof Error && e.message === s.pickupOrder ? s.pickupOrder : errorMessage(e)),
  });
  return (
    <Card>
      {inherited && target ? <p className="mb-4 rounded-lg bg-surface p-3 text-sm">{s.usingGlobal}</p> : null}
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!readOnly) save.mutate();
        }}
      >
        <label className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
          <span className="font-bold">{s.fields.require_supervisor_geo}</span>
          <Switch checked={form.require_supervisor_geo} disabled={readOnly} onCheckedChange={(v) => setForm({ ...form, require_supervisor_geo: v })} />
        </label>
        <div className="grid gap-4 md:grid-cols-2">
          {NUMERIC.map((f) => (
            <Field key={f.key} label={s.fields[f.key]} htmlFor={`${baseId}-${f.key}`}>
              <Input
                id={`${baseId}-${f.key}`}
                type="number"
                inputMode="numeric"
                min={f.min}
                max={f.max}
                disabled={readOnly}
                value={String(form[f.key])}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              />
            </Field>
          ))}
        </div>
        <fieldset className="rounded-lg border border-border p-3">
          <legend className="px-1 font-bold">{s.pickupWindow}</legend>
          <p className="mb-3 text-xs text-muted">{s.pickupHint}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {(['pickup_open_time', 'pickup_close_time'] as const).map((key) => (
              <Field key={key} label={s.fields[key]} htmlFor={`${baseId}-${key}`}>
                <TimeInput12
                  id={`${baseId}-${key}`}
                  disabled={readOnly}
                  value={(form[key] ?? '').slice(0, 5)}
                  onChange={(v) => setForm({ ...form, [key]: v })}
                  testId={key}
                />
              </Field>
            ))}
          </div>
        </fieldset>
        {!readOnly ? (
          <div className="flex justify-end">
            <Button type="submit" variant="secondary" disabled={save.isPending}>
              {inherited && target ? s.createOverride : t.common.save}
            </Button>
          </div>
        ) : null}
      </form>
    </Card>
  );
}
