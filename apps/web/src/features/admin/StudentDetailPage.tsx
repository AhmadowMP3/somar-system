import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Printer, QrCode as QrIcon, ShieldCheck, ShieldOff, UserRound, ImageOff, Power, PlusCircle, Package as PackageIcon, XCircle } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { damascusDate, formatClock, formatDate, formatDateTime, formatPhoneDisplay, weekStart } from '@somar/shared';
import { useScope } from '@/app/auth';
import { DirectionBadge } from '@/components/common';
import { QrCode } from '@/components/QrCode';
import { ConfirmDialog, Dialog, useToast } from '@/components/ui/overlay';
import { Badge, Button, Card, CardTitle, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { DaysEditor, scheduleProblem, toDayRows, toSchedulePayload, type DayRow, type ScheduleRow } from '@/features/student/SetupPage';
import type { Dashboard } from '@/features/student/StudentPages';
import { t } from '@/i18n/ar';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { PHOTO_BUCKET, signedUrl, supabase, unwrap } from '@/lib/supabase';
import { ActiveBadge, useIsAdmin, usePackages } from './common';
import { memberPath } from './MembersPage';

type StudentFull = {
  id: string;
  profile_id: string | null;
  university_id: string;
  transport_number: string;
  qr_token: string;
  full_name: string;
  kind: 'student' | 'doctor' | 'employee';
  university_student_no: string | null;
  national_id: string | null;
  phone_e164: string | null;
  residence_text: string | null;
  area_other_text: string | null;
  work_days: number[];
  shift_start: string | null;
  job_title: string | null;
  home_stop: { name: string } | null;
  work_hours_text: string | null;
  notes: string | null;
  photo_path: string | null;
  is_active: boolean;
  colleges: { name: string } | null;
  area1: { name: string } | null;
  area2: { name: string } | null;
  profiles: { role: string; must_change_password: boolean } | null;
};

type Adjustment = { id: string; week_start: string | null; delta_trips: number; reason: string | null; created_at: string };
type ScanRow = {
  id: string;
  scanned_at: string;
  direction: string;
  method: string;
  offday_override: boolean;
  override_reason: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  remaining_after: number;
  bus_number: string | null;
};

type Action =
  | 'resetPassword'
  | 'resetPhoto'
  | 'regenerateQr'
  | 'promote'
  | 'demote'
  | 'toggleActive'
  | 'cancelSubscription'
  | 'assign'
  | 'adjust'
  | null;

export default function StudentDetailPage() {
  const { id = '' } = useParams();
  const s = t.admin.students;
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const toast = useToast();
  const [action, setAction] = useState<Action>(null);

  const student = useQuery({
    queryKey: ['student', id],
    queryFn: async () =>
      unwrap(
        await supabase
          .from('students')
          .select(
            'id, profile_id, university_id, transport_number, qr_token, full_name, kind, university_student_no, national_id, phone_e164, residence_text, area_other_text, work_days, shift_start, job_title, home_stop:stops!students_home_stop_id_fkey(name), work_hours_text, notes, photo_path, is_active, colleges(name), area1:areas!students_area_primary_id_fkey(name), area2:areas!students_area_secondary_id_fkey(name), profiles(role, must_change_password)',
          )
          .eq('id', id)
          .single(),
      ) as unknown as StudentFull,
  });
  const dash = useQuery({
    queryKey: ['student-dashboard', id],
    queryFn: async () => unwrap(await supabase.rpc('student_dashboard', { p_student_id: id })) as Dashboard,
  });
  const adjustments = useQuery({
    queryKey: ['adjustments', id, dash.data?.subscription?.id],
    enabled: Boolean(dash.data?.subscription?.id),
    queryFn: async () =>
      unwrap(
        await supabase
          .from('subscription_adjustments')
          .select('id, week_start, delta_trips, reason, created_at')
          .eq('subscription_id', dash.data?.subscription?.id as string)
          .order('created_at', { ascending: false }),
      ) as Adjustment[],
  });
  const scans = useQuery({
    queryKey: ['student-scans', id],
    queryFn: async () =>
      unwrap(
        await supabase
          .from('scans')
          .select('id, scanned_at, direction, method, offday_override, override_reason, cancelled_at, cancel_reason, remaining_after, bus_number')
          .eq('student_id', id)
          .order('scanned_at', { ascending: false })
          .limit(100),
      ) as ScanRow[],
  });
  const photo = useQuery({
    queryKey: ['photo-url', student.data?.photo_path],
    enabled: Boolean(student.data?.photo_path),
    queryFn: () => signedUrl(PHOTO_BUCKET, student.data?.photo_path),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['student', id] });
    void qc.invalidateQueries({ queryKey: ['student-dashboard', id] });
    void qc.invalidateQueries({ queryKey: ['adjustments', id] });
    void qc.invalidateQueries({ queryKey: ['students'] });
  };

  const run = useMutation({
    mutationFn: async (a: Exclude<Action, null | 'assign' | 'adjust'>) => {
      const st = student.data as StudentFull;
      switch (a) {
        case 'resetPassword':
          await api.post(`/students/${id}/reset-password`);
          return s.resetPasswordDone;
        case 'resetPhoto':
          await api.post(`/students/${id}/reset-photo`);
          return t.common.success;
        case 'regenerateQr':
          await api.post(`/students/${id}/regenerate-qr`);
          return s.regenerateQrDone;
        case 'promote':
          unwrap(await supabase.rpc('promote_student_to_supervisor', { p_student_id: id }));
          return t.common.success;
        case 'demote':
          unwrap(await supabase.rpc('demote_supervisor_to_student', { p_profile_id: st.profile_id }));
          return t.common.success;
        case 'toggleActive':
          unwrap(await supabase.from('students').update({ is_active: !st.is_active }).eq('id', id));
          return t.common.success;
        case 'cancelSubscription':
          unwrap(await supabase.from('subscriptions').update({ status: 'cancelled' }).eq('id', dash.data?.subscription?.id as string));
          return t.common.success;
      }
    },
    onSuccess: (msg) => {
      toast.success(msg);
      setAction(null);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const confirmText: Partial<Record<Exclude<Action, null>, { title: string; body: string; danger?: boolean }>> = {
    resetPassword: { title: s.resetPassword, body: s.resetPasswordConfirm },
    resetPhoto: { title: s.resetPhoto, body: s.resetPhotoConfirm, danger: true },
    regenerateQr: { title: s.regenerateQr, body: s.regenerateQrConfirm, danger: true },
    promote: { title: s.promote, body: s.promoteConfirm },
    demote: { title: s.demote, body: t.admin.supervisors.demoteConfirm },
    toggleActive: student.data?.is_active
      ? { title: t.common.deactivate, body: s.deactivateConfirm, danger: true }
      : { title: t.common.activate, body: s.activateConfirm },
    cancelSubscription: { title: s.cancelSubscription, body: s.cancelSubscriptionConfirm, danger: true },
  };
  const confirm = action && action !== 'assign' && action !== 'adjust' ? confirmText[action] : undefined;

  return (
    <QueryState query={student}>
      {(st) => {
        const role = st.profiles?.role;
        // Doctors and university employees: no package, unlimited trips.
        const member = st.kind !== 'student' ? st.kind : null;
        const editHref = member ? `${memberPath(member)}/${id}/edit` : `/admin/students/${id}/edit`;
        return (
          <div className="space-y-4">
            <PageHeader
              title={st.full_name}
              subtitle={<span className="num font-mono">{st.transport_number}</span>}
              actions={
                <>
                  <Button asChild size="sm">
                    <Link to={editHref}>
                      <Pencil className="h-4 w-4" aria-hidden />
                      {t.common.edit}
                    </Link>
                  </Button>
                  <Button asChild size="sm">
                    <Link to={`/admin/cards?ids=${id}`}>
                      <Printer className="h-4 w-4" aria-hidden />
                      {s.printCard}
                    </Link>
                  </Button>
                </>
              }
            />
            <div className="grid gap-4 lg:grid-cols-3">
              <Card className="flex flex-col items-center gap-3 text-center">
                {photo.data ? (
                  <img src={photo.data} alt={st.full_name} className="h-40 w-40 rounded-xl object-cover" />
                ) : (
                  <div className="flex h-40 w-40 items-center justify-center rounded-xl bg-surface text-muted">
                    <UserRound className="h-14 w-14" aria-hidden />
                  </div>
                )}
                <div className="flex flex-wrap justify-center gap-2">
                  <ActiveBadge active={st.is_active} />
                  {role === 'supervisor' ? <Badge tone="info">{s.isSupervisor}</Badge> : null}
                </div>
                <QrCode token={st.qr_token} className="h-36 w-36" label={s.qr} />
              </Card>
              <Card className="lg:col-span-2">
                <CardTitle>{member ? t.admin.members[member].detail : s.detail}</CardTitle>
                <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-sm">
                  {member ? (
                    <>
                      <dt className="text-muted">{t.student.jobTitle}</dt>
                      <dd>{st.job_title ?? t.common.none}</dd>
                      <dt className="text-muted">{t.student.homeStop}</dt>
                      <dd>{st.home_stop?.name ?? t.admin.members.stopPending}</dd>
                    </>
                  ) : (
                    <>
                      <dt className="text-muted">{t.student.universityNo}</dt>
                      <dd className="num">{st.university_student_no}</dd>
                      <dt className="text-muted">{t.student.nationalId}</dt>
                      <dd className="num">{st.national_id ?? t.common.none}</dd>
                      <dt className="text-muted">{t.student.homeStop}</dt>
                      <dd>{st.home_stop?.name ?? t.common.none}</dd>
                    </>
                  )}
                  <dt className="text-muted">{t.student.phone}</dt>
                  <dd className="num">{st.phone_e164 ? formatPhoneDisplay(st.phone_e164) : t.common.none}</dd>
                  {member ? null : (
                    <>
                      <dt className="text-muted">{t.student.college}</dt>
                      <dd>{st.colleges?.name}</dd>
                    </>
                  )}
                  <dt className="text-muted">{t.student.area}</dt>
                  <dd>
                    {st.area1?.name ?? t.common.none}
                    {st.area2 ? ` / ${st.area2.name}` : ''}
                    {st.area_other_text ? <Badge tone="warning" className="ms-2">{st.area_other_text}</Badge> : null}
                  </dd>
                  <dt className="text-muted">{t.student.residence}</dt>
                  <dd>{st.residence_text ?? t.common.none}</dd>
                  <dt className="text-muted">{t.student.workDays}</dt>
                  <dd>{st.work_days.length ? st.work_days.map((d) => t.days[d]).join(t.listSeparator) : t.common.none}</dd>
                  {st.shift_start ? (
                    <>
                      <dt className="text-muted">{t.student.shiftStart}</dt>
                      <dd className="num">{formatClock(st.shift_start)}</dd>
                    </>
                  ) : null}
                  {st.work_hours_text ? (
                    <>
                      <dt className="text-muted">{t.student.workHours}</dt>
                      <dd>{st.work_hours_text}</dd>
                    </>
                  ) : null}
                  {st.notes ? (
                    <>
                      <dt className="text-muted">{t.admin.members.notes}</dt>
                      <dd className="whitespace-pre-line">{st.notes}</dd>
                    </>
                  ) : null}
                </dl>
              </Card>
            </div>

            {member ? (
              <Card className="border-success/40">
                <CardTitle>{s.balanceThisWeek}</CardTitle>
                <p className="text-3xl font-extrabold text-success" data-testid="detail-quota">
                  {t.admin.members.unlimited}
                </p>
                <p className="text-sm text-muted">{t.admin.members.unlimitedNote}</p>
              </Card>
            ) : (
            <QueryState query={dash}>
              {(d) => (
                <div className="grid gap-4 lg:grid-cols-2">
                  <Card>
                    <CardTitle>{s.balanceThisWeek}</CardTitle>
                    <p className="text-3xl font-extrabold text-brand-ink" data-testid="detail-quota">
                      <span className="num">{d.balance.remaining}</span>
                      <span className="text-lg text-muted">
                        {' '}
                        {t.common.of} <span className="num" data-testid="detail-quota-value">{d.balance.quota}</span>
                      </span>
                    </p>
                    <p className="text-sm text-muted">{t.student.weekStarts(formatDate(d.balance.week_start))}</p>
                  </Card>
                  <Card>
                    <CardTitle>{s.subscription}</CardTitle>
                    {d.subscription ? (
                      <div className="space-y-1 text-sm">
                        <p className="font-bold" data-testid="detail-package">{d.subscription.package_name}</p>
                        <p>
                          {s.startsOn} <span className="num">{formatDate(d.subscription.starts_on)}</span> — {s.endsOn}{' '}
                          <span className="num">{formatDate(d.subscription.ends_on)}</span>
                        </p>
                        <Badge>{s.subStatus[d.subscription.status] ?? d.subscription.status}</Badge>
                      </div>
                    ) : (
                      <p className="text-sm text-muted">{s.noSubscription}</p>
                    )}
                  </Card>
                </div>
              )}
            </QueryState>
            )}

            <Card>
              <CardTitle>{t.common.actions}</CardTitle>
              <div className="flex flex-wrap gap-3">
                {isAdmin ? (
                  <>
                    {member ? null : (
                      <ActionButton icon={<PackageIcon className="h-4 w-4" />} onClick={() => setAction('assign')} testId="assign-package">
                        {s.assign}
                      </ActionButton>
                    )}
                    {dash.data?.subscription && !member ? (
                      <>
                        <ActionButton icon={<PlusCircle className="h-4 w-4" />} onClick={() => setAction('adjust')}>
                          {s.addTrips}
                        </ActionButton>
                        <ActionButton icon={<XCircle className="h-4 w-4" />} onClick={() => setAction('cancelSubscription')}>
                          {s.cancelSubscription}
                        </ActionButton>
                      </>
                    ) : null}
                    <ActionButton icon={<KeyRound className="h-4 w-4" />} onClick={() => setAction('resetPassword')}>
                      {s.resetPassword}
                    </ActionButton>
                    <ActionButton icon={<ImageOff className="h-4 w-4" />} onClick={() => setAction('resetPhoto')}>
                      {s.resetPhoto}
                    </ActionButton>
                    <ActionButton icon={<QrIcon className="h-4 w-4" />} onClick={() => setAction('regenerateQr')}>
                      {s.regenerateQr}
                    </ActionButton>
                    {role === 'student' ? (
                      <ActionButton icon={<ShieldCheck className="h-4 w-4" />} onClick={() => setAction('promote')}>
                        {s.promote}
                      </ActionButton>
                    ) : null}
                    {role === 'supervisor' ? (
                      <ActionButton icon={<ShieldOff className="h-4 w-4" />} onClick={() => setAction('demote')}>
                        {s.demote}
                      </ActionButton>
                    ) : null}
                  </>
                ) : null}
                <ActionButton icon={<Power className="h-4 w-4" />} onClick={() => setAction('toggleActive')}>
                  {st.is_active ? t.common.deactivate : t.common.activate}
                </ActionButton>
              </div>
            </Card>

            <ScheduleCard studentId={st.id} workDays={st.work_days} />

            <div className="grid gap-4 lg:grid-cols-2">
              {member ? null : (
              <Card>
                <CardTitle>{s.adjustments}</CardTitle>
                {dash.data?.subscription ? (
                  <QueryState query={adjustments} empty={(rows) => (rows.length ? null : <p className="text-sm text-muted">{s.noAdjustments}</p>)}>
                    {(rows) => (
                      <ul className="divide-y divide-border text-sm">
                        {rows.map((a) => (
                          <li key={a.id} className="flex items-center justify-between gap-2 py-2">
                            <span>
                              {a.week_start ? s.adjustWeek(formatDate(a.week_start)) : s.adjustPermanent}
                              {a.reason ? <span className="block text-xs text-muted">{a.reason}</span> : null}
                            </span>
                            <Badge tone={a.delta_trips > 0 ? 'success' : 'danger'}>
                              <span className="num">{a.delta_trips > 0 ? `+${a.delta_trips}` : a.delta_trips}</span>
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                  </QueryState>
                ) : (
                  <p className="text-sm text-muted">{s.noSubscription}</p>
                )}
              </Card>
              )}
              <Card className={member ? 'lg:col-span-2' : undefined}>
                <CardTitle>{s.scanHistory}</CardTitle>
                <QueryState query={scans} empty={(rows) => (rows.length ? null : <EmptyState title={s.noScans} />)}>
                  {(rows) => (
                    <ul className="max-h-96 divide-y divide-border overflow-y-auto text-sm">
                      {rows.map((sc) => (
                        <li key={sc.id} className={sc.cancelled_at ? 'py-2 opacity-60' : 'py-2'}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-2">
                              <DirectionBadge direction={sc.direction} />
                              {sc.method === 'manual' ? <Badge>{t.student.manual}</Badge> : null}
                              {sc.bus_number ? (
                                <Badge>
                                  {t.admin.scans.bus} <span className="num">{sc.bus_number}</span>
                                </Badge>
                              ) : null}
                              {sc.offday_override ? <Badge tone="warning">{t.student.override}</Badge> : null}
                              {sc.cancelled_at ? <Badge tone="danger">{t.admin.scans.cancelled}</Badge> : null}
                            </span>
                            <span className="num text-muted">{formatDateTime(sc.scanned_at)}</span>
                          </div>
                          {sc.cancel_reason ? <p className="mt-1 text-xs text-muted">{sc.cancel_reason}</p> : null}
                          {sc.override_reason ? <p className="mt-1 text-xs text-muted">{sc.override_reason}</p> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </QueryState>
              </Card>
            </div>

            {confirm && action ? (
              <ConfirmDialog
                open
                onOpenChange={(o) => !o && setAction(null)}
                title={confirm.title}
                body={confirm.body}
                danger={confirm.danger}
                busy={run.isPending}
                onConfirm={() => run.mutate(action as Exclude<Action, null | 'assign' | 'adjust'>)}
              />
            ) : null}
            {action === 'assign' ? <AssignDialog student={st} onClose={() => setAction(null)} onDone={refresh} /> : null}
            {action === 'adjust' && dash.data?.subscription ? (
              <AdjustDialog subscriptionId={dash.data.subscription.id} onClose={() => setAction(null)} onDone={refresh} />
            ) : null}
          </div>
        );
      }}
    </QueryState>
  );
}

function ActionButton({ icon, children, onClick, testId }: { icon: ReactNode; children: ReactNode; onClick: () => void; testId?: string }) {
  return (
    <Button size="sm" onClick={onClick} data-testid={testId}>
      {icon}
      {children}
    </Button>
  );
}

function AssignDialog({ student, onClose, onDone }: { student: StudentFull; onClose: () => void; onDone: () => void }) {
  const s = t.admin.students;
  const toast = useToast();
  const packages = usePackages(student.university_id);
  const [packageId, setPackageId] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [note, setNote] = useState('');
  const ids = { pkg: useId(), start: useId(), end: useId(), note: useId() };
  const pick = (id: string) => {
    setPackageId(id);
    const p = packages.data?.find((x) => x.id === id);
    if (p) {
      setStartsOn(p.semester_start);
      setEndsOn(p.semester_end);
    }
  };
  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        await supabase.rpc('assign_subscription', {
          p_student_id: student.id,
          p_package_id: packageId,
          p_starts_on: startsOn || null,
          p_ends_on: endsOn || null,
          p_note: note.trim() || null,
        }),
      ),
    onSuccess: () => {
      toast.success(t.common.success);
      onDone();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={s.assignTitle} description={s.assignNote}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (packageId) save.mutate();
        }}
      >
        <Field label={t.student.package} htmlFor={ids.pkg}>
          <Select id={ids.pkg} value={packageId} onChange={(e) => pick(e.target.value)} data-testid="assign-select">
            <option value="">{t.common.select}</option>
            {(packages.data ?? [])
              .filter((p) => p.is_active)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={s.startsOn} htmlFor={ids.start}>
            <Input id={ids.start} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </Field>
          <Field label={s.endsOn} htmlFor={ids.end}>
            <Input id={ids.end} type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </Field>
        </div>
        <Field label={t.common.notes} htmlFor={ids.note}>
          <Textarea id={ids.note} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-3">
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button type="submit" variant="secondary" disabled={!packageId || save.isPending} data-testid="assign-submit">
            {t.common.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AdjustDialog({ subscriptionId, onClose, onDone }: { subscriptionId: string; onClose: () => void; onDone: () => void }) {
  const s = t.admin.students;
  const p = t.admin.packages;
  const toast = useToast();
  const { university } = useScope();
  const [scope, setScope] = useState<'this_week' | 'week' | 'permanent'>('this_week');
  const [weekDate, setWeekDate] = useState(damascusDate());
  const [delta, setDelta] = useState(1);
  const [reason, setReason] = useState('');
  const ids = { scope: useId(), week: useId(), delta: useId(), reason: useId() };
  const save = useMutation({
    mutationFn: async () => {
      const dow = university?.week_start_dow ?? 6;
      const ws = scope === 'permanent' ? null : weekStart(scope === 'week' ? weekDate : damascusDate(), dow);
      const { data: session } = await supabase.auth.getSession();
      unwrap(
        await supabase.from('subscription_adjustments').insert({
          subscription_id: subscriptionId,
          week_start: ws,
          delta_trips: delta,
          reason: reason.trim() || null,
          created_by: session.session?.user.id ?? null,
        }),
      );
    },
    onSuccess: () => {
      toast.success(t.common.success);
      onDone();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={s.adjustTitle}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (delta !== 0) save.mutate();
        }}
      >
        <Field label={p.scope} htmlFor={ids.scope}>
          <Select id={ids.scope} value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="this_week">{p.scopeThisWeek}</option>
            <option value="week">{p.scopeWeek}</option>
            <option value="permanent">{p.scopePermanent}</option>
          </Select>
        </Field>
        {scope === 'week' ? (
          <Field label={p.weekDate} htmlFor={ids.week}>
            <Input id={ids.week} type="date" value={weekDate} onChange={(e) => setWeekDate(e.target.value)} />
          </Field>
        ) : null}
        <Field label={p.delta} htmlFor={ids.delta}>
          <Input id={ids.delta} type="number" value={delta} onChange={(e) => setDelta(Number(e.target.value))} />
        </Field>
        <Field label={t.common.reason} htmlFor={ids.reason}>
          <Textarea id={ids.reason} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-3">
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button type="submit" variant="secondary" disabled={delta === 0 || save.isPending}>
            {t.common.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ScheduleCard({ studentId, workDays }: { studentId: string; workDays: number[] }) {
  const s = t.admin.students;
  const qc = useQueryClient();
  const toast = useToast();
  const { university } = useScope();
  const [days, setDays] = useState<DayRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['student-schedule', studentId],
    queryFn: async () =>
      unwrap(
        await supabase.from('student_schedule').select('dow, outbound_time, return_time').eq('student_id', studentId).order('dow'),
      ) as ScheduleRow[],
  });
  const save = useMutation({
    mutationFn: async (rows: DayRow[]) =>
      unwrap(await supabase.rpc('save_student_schedule', { p_student_id: studentId, p_schedule: toSchedulePayload(rows) })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['student-schedule', studentId] });
      void qc.invalidateQueries({ queryKey: ['student', studentId] });
      void qc.invalidateQueries({ queryKey: ['schedule-stats'] });
      toast.success(t.setup.saved);
      setDays(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const openEditor = () => {
    setError(null);
    setDays(toDayRows(university?.week_start_dow ?? 6, query.data ?? [], workDays));
  };
  const submit = () => {
    if (!days) return;
    const problem = scheduleProblem(days);
    setError(problem);
    if (!problem) save.mutate(days);
  };
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-2">
        <CardTitle className="mb-0">{s.weeklySchedule}</CardTitle>
        <Button size="sm" variant="outline" disabled={!query.data} onClick={openEditor} data-testid="edit-schedule">
          <Pencil className="h-4 w-4" aria-hidden />
          {s.editSchedule}
        </Button>
      </div>
      <QueryState query={query} empty={(rows) => (rows.length ? null : <p className="text-sm text-muted">{s.noSchedule}</p>)}>
        {(rows) => (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" data-testid="student-schedule">
            {rows.map((r) => (
              <li key={r.dow} className="rounded-lg bg-surface p-2 text-sm">
                <p className="font-bold">{t.days[r.dow]}</p>
                <p>
                  {t.setup.outbound}: <span className="num font-semibold">{formatClock(r.outbound_time)}</span>
                </p>
                <p>
                  {t.setup.return}: <span className="num font-semibold">{formatClock(r.return_time)}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      <Dialog
        open={days !== null}
        onOpenChange={(o) => (o ? undefined : setDays(null))}
        title={s.editSchedule}
        description={s.editScheduleHint}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDays(null)}>
              {t.common.cancel}
            </Button>
            <Button variant="primary" disabled={save.isPending} onClick={submit} data-testid="schedule-save">
              {save.isPending ? t.common.saving : t.common.save}
            </Button>
          </>
        }
      >
        {days ? <DaysEditor days={days} onChange={setDays} /> : null}
        {error ? (
          <p role="alert" className="mt-3 rounded-lg bg-danger/10 p-3 text-sm font-semibold text-danger">
            {error}
          </p>
        ) : null}
      </Dialog>
    </Card>
  );
}
