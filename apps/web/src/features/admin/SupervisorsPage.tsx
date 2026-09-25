import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, ShieldOff } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { ConfirmDialog, Dialog, useToast } from '@/components/ui/overlay';
import { Badge, Button, Field, Input, Select, Switch } from '@/components/ui/primitives';
import { DataList, EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { supabase, unwrap } from '@/lib/supabase';
import { useIsAdmin, WithUniversity } from './common';

type StaffRow = {
  id: string;
  login_code: string;
  role: string;
  full_name: string;
  phone: string | null;
  is_active: boolean;
  students: { id: string }[] | { id: string } | null;
};

export default function SupervisorsPage() {
  return <WithUniversity>{(universityId) => <SupervisorsBody universityId={universityId} />}</WithUniversity>;
}

function hasStudent(row: StaffRow): boolean {
  return Array.isArray(row.students) ? row.students.length > 0 : Boolean(row.students);
}

function SupervisorsBody({ universityId }: { universityId: string }) {
  const sv = t.admin.supervisors;
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [demoting, setDemoting] = useState<StaffRow | null>(null);
  const [resetting, setResetting] = useState<StaffRow | null>(null);
  const query = useQuery({
    queryKey: ['supervisors', universityId],
    queryFn: async () =>
      unwrap(
        await supabase
          .from('profiles')
          .select('id, login_code, role, full_name, phone, is_active, students(id)')
          .eq('university_id', universityId)
          .in('role', ['supervisor', 'university_supervisor'])
          .order('login_code'),
      ) as StaffRow[],
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['supervisors', universityId] });
  const toggle = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) =>
      unwrap(await supabase.from('profiles').update({ is_active: active }).eq('id', id)),
    onSuccess: invalidate,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const demote = useMutation({
    mutationFn: async (id: string) => unwrap(await supabase.rpc('demote_supervisor_to_student', { p_profile_id: id })),
    onSuccess: () => {
      invalidate();
      setDemoting(null);
      toast.success(t.common.success);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div>
      <PageHeader
        title={sv.title}
        subtitle={sv.promoteHint}
        actions={
          isAdmin ? (
            <Button variant="secondary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              {sv.add}
            </Button>
          ) : undefined
        }
      />
      <QueryState query={query} empty={(rows) => (rows.length ? null : <EmptyState title={sv.empty} />)}>
        {(rows) => (
          <DataList
            rows={rows}
            rowKey={(r) => r.id}
            cardTitle={(r) => r.full_name}
            columns={[
              { key: 'code', header: sv.loginCode, cell: (r) => <span className="num font-mono">{r.login_code}</span> },
              { key: 'name', header: t.common.name, cell: (r) => r.full_name, mobileHidden: true },
              { key: 'role', header: sv.role, cell: (r) => t.roles[r.role] },
              {
                key: 'kind',
                header: t.common.details,
                cell: (r) => <Badge tone={hasStudent(r) ? 'info' : 'neutral'}>{hasStudent(r) ? sv.promoted : sv.standalone}</Badge>,
              },
              {
                key: 'active',
                header: t.common.status,
                cell: (r) => (
                  <Switch checked={r.is_active} aria-label={t.common.active} onCheckedChange={(v) => toggle.mutate({ id: r.id, active: v })} />
                ),
              },
              ...(isAdmin
                ? [
                    {
                      key: 'actions',
                      header: t.common.actions,
                      cell: (r: StaffRow) => (
                        <div className="flex flex-wrap gap-2">
                          {!hasStudent(r) ? (
                            <Button size="sm" onClick={() => setResetting(r)}>
                              <KeyRound className="h-4 w-4" aria-hidden />
                              {sv.resetPassword}
                            </Button>
                          ) : null}
                          {hasStudent(r) && r.role === 'supervisor' ? (
                            <Button size="sm" onClick={() => setDemoting(r)}>
                              <ShieldOff className="h-4 w-4" aria-hidden />
                              {sv.demote}
                            </Button>
                          ) : null}
                        </div>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </QueryState>
      {creating ? <CreateDialog universityId={universityId} onClose={() => setCreating(false)} onDone={invalidate} /> : null}
      {resetting ? <ResetDialog row={resetting} onClose={() => setResetting(null)} /> : null}
      <ConfirmDialog
        open={demoting !== null}
        onOpenChange={(o) => !o && setDemoting(null)}
        title={sv.demote}
        body={sv.demoteConfirm}
        busy={demote.isPending}
        onConfirm={() => demoting && demote.mutate(demoting.id)}
      />
    </div>
  );
}

function CreateDialog({ universityId, onClose, onDone }: { universityId: string; onClose: () => void; onDone: () => void }) {
  const sv = t.admin.supervisors;
  const toast = useToast();
  const [form, setForm] = useState({ login_code: '', full_name: '', phone: '', password: '', role: 'supervisor' });
  const ids = { code: useId(), name: useId(), phone: useId(), pw: useId(), role: useId() };
  const save = useMutation({
    mutationFn: () => api.post('/supervisors', { ...form, phone: form.phone || null, university_id: universityId }),
    onSuccess: () => {
      toast.success(t.common.success);
      onDone();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const valid = /^[A-Za-z0-9._-]{2,40}$/.test(form.login_code) && form.full_name.trim().length >= 2 && form.password.length >= 6;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) save.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={sv.add}>
      <form className="space-y-4" onSubmit={submit}>
        <Field label={sv.loginCode} htmlFor={ids.code} hint={sv.loginCodeHint}>
          <Input id={ids.code} dir="ltr" className="text-start uppercase" value={form.login_code} onChange={(e) => setForm({ ...form, login_code: e.target.value.toUpperCase().trim() })} />
        </Field>
        <Field label={t.common.name} htmlFor={ids.name}>
          <Input id={ids.name} value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        </Field>
        <Field label={t.student.phone} htmlFor={ids.phone}>
          <Input id={ids.phone} dir="ltr" className="text-start" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label={sv.role} htmlFor={ids.role}>
          <Select id={ids.role} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="supervisor">{t.roles.supervisor}</option>
            <option value="university_supervisor">{t.roles.university_supervisor}</option>
          </Select>
        </Field>
        <Field label={sv.password} htmlFor={ids.pw}>
          <Input id={ids.pw} dir="ltr" className="text-start" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button type="submit" variant="secondary" disabled={!valid || save.isPending}>
            {t.common.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ResetDialog({ row, onClose }: { row: StaffRow; onClose: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const id = useId();
  const save = useMutation({
    mutationFn: () => api.post(`/supervisors/${row.id}/reset-password`, { password }),
    onSuccess: () => {
      toast.success(t.common.success);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t.admin.supervisors.resetPassword} description={row.full_name}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (password.length >= 6) save.mutate();
        }}
      >
        <Field label={t.auth.newPassword} htmlFor={id}>
          <Input id={id} dir="ltr" className="text-start" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button type="submit" variant="secondary" disabled={password.length < 6 || save.isPending}>
            {t.common.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
