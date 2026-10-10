import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCircle2, FileSpreadsheet, FileText, Package as PackageIcon, PauseCircle, Printer, Trash2, X } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/app/auth';
import { ConfirmDialog, Dialog, useToast } from '@/components/ui/overlay';
import { Button, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { t } from '@/i18n/ar';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { exportSheet } from '@/lib/exportSheet';
import { storeSelection } from '@/lib/selection';
import { supabase, unwrap } from '@/lib/supabase';
import { useIsAdmin, usePackages } from './common';

type Action = 'package' | 'activate' | 'deactivate' | 'delete' | 'notify';
type Failure = { student_id: string; code: string };
type Outcome = { done: number; failed: Failure[]; error?: unknown };
type Progress = { done: number; total: number };

// ids per request: keeps URLs short and gives a visible progress count
const UPDATE_CHUNK = 200;
const ASSIGN_CHUNK = 200;
const DELETE_CHUNK = 100;
const READ_CHUNK = 150;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Runs `run` on each chunk in turn, reporting how many ids are done. A chunk that throws after
 * earlier chunks went through stops the run and reports the rest as failed, so the caller still
 * refreshes the list and clears what was already applied.
 */
async function inChunks(ids: string[], size: number, onProgress: (p: Progress) => void, run: (part: string[]) => Promise<Outcome>) {
  const total: Outcome = { done: 0, failed: [] };
  let handled = 0;
  onProgress({ done: 0, total: ids.length });
  for (const part of chunks(ids, size)) {
    let res: Outcome;
    try {
      res = await run(part);
    } catch (error) {
      if (!handled) throw error;
      total.failed.push(...ids.slice(handled).map((id) => ({ student_id: id, code: 'INTERNAL' })));
      return { ...total, error };
    }
    total.done += res.done;
    total.failed.push(...res.failed);
    handled += part.length;
    onProgress({ done: handled, total: ids.length });
  }
  return total;
}

type ExportRow = {
  student_id: string;
  transport_number: string;
  full_name: string;
  university_student_no: string | null;
  phone_e164: string | null;
  college_name: string | null;
  package_name: string | null;
  package_id: string | null;
  quota: number;
  remaining: number;
  area_primary_name: string | null;
  area_other_text: string | null;
  has_photo: boolean;
  is_active: boolean;
};

async function exportSelected(ids: string[]) {
  const rows: ExportRow[] = [];
  for (const part of chunks(ids, READ_CHUNK)) {
    rows.push(
      ...(unwrap(
        await supabase
          .from('v_rider_balance')
          .select(
            'student_id, transport_number, full_name, university_student_no, phone_e164, college_name, package_name, package_id, quota, remaining, area_primary_name, area_other_text, has_photo, is_active',
          )
          .in('student_id', part),
      ) as unknown as ExportRow[]),
    );
  }
  rows.sort((a, b) => a.transport_number.localeCompare(b.transport_number));
  const s = t.admin.students;
  exportSheet(
    s.bulk.exportFile,
    rows.map((r) => ({
      [t.student.transportNumber]: r.transport_number,
      [t.common.name]: r.full_name,
      [t.student.universityNo]: r.university_student_no ?? '',
      [t.student.phone]: r.phone_e164 ?? '',
      [t.student.college]: r.college_name ?? '',
      [t.student.package]: r.package_name ?? s.noSubscription,
      [t.student.remainingShort]: r.package_id ? `${r.remaining} / ${r.quota}` : '',
      [t.student.area]: r.area_primary_name ?? r.area_other_text ?? '',
      [t.student.photo]: r.has_photo ? '✓' : s.filters.noPhoto,
      [t.common.status]: r.is_active ? t.common.active : t.common.inactive,
    })),
  );
  return rows.length;
}

/** Names for the failure list (only the few that failed). */
async function describeFailures(failed: Failure[]) {
  const ids = failed.slice(0, 50).map((f) => f.student_id);
  const names = new Map<string, { transport_number: string; full_name: string }>();
  for (const part of chunks(ids, READ_CHUNK)) {
    const rows = unwrap(await supabase.from('students').select('id, transport_number, full_name').in('id', part)) as {
      id: string;
      transport_number: string;
      full_name: string;
    }[];
    for (const r of rows) names.set(r.id, r);
  }
  return failed.slice(0, 50).map((f) => ({ ...f, student: names.get(f.student_id) }));
}

type DescribedFailure = Awaited<ReturnType<typeof describeFailures>>[number];

/**
 * Sticky bar for the students picked on the list: package, activate/deactivate, delete, notify,
 * Excel / PDF export and cards. Each action reports partial failures and clears the selection when done.
 */
export function StudentsBulkBar({ universityId, ids, onClear }: { universityId: string; ids: string[]; onClear: () => void }) {
  const b = t.admin.students.bulk;
  const { can } = useAuth();
  const isAdmin = useIsAdmin();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [action, setAction] = useState<Action | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<{ done: number; failed: DescribedFailure[]; total: number } | null>(null);
  const n = ids.length;

  const finish = async (outcome: Outcome, message: string) => {
    setAction(null);
    setProgress(null);
    void qc.invalidateQueries({ queryKey: ['students'] });
    if (outcome.done) toast.success(message);
    if (outcome.error) toast.error(errorMessage(outcome.error));
    if (outcome.failed.length) {
      setResult({ done: outcome.done, failed: await describeFailures(outcome.failed), total: outcome.failed.length });
    }
    onClear();
  };

  const setActive = useMutation({
    mutationFn: (active: boolean) =>
      inChunks(ids, UPDATE_CHUNK, setProgress, async (part) => {
        const updated = unwrap(
          await supabase.from('students').update({ is_active: active }).eq('university_id', universityId).in('id', part).select('id'),
        ) as { id: string }[];
        const ok = new Set(updated.map((r) => r.id));
        return { done: ok.size, failed: part.filter((id) => !ok.has(id)).map((id) => ({ student_id: id, code: 'NOT_FOUND' })) };
      }),
    onSuccess: (outcome) => void finish(outcome, b.activeDone(outcome.done)),
    onError: (e) => {
      setProgress(null);
      toast.error(errorMessage(e));
    },
  });

  const remove = useMutation({
    mutationFn: () =>
      inChunks(ids, DELETE_CHUNK, setProgress, async (part) => {
        const res = await api.post<{ deleted: number; failed: Failure[] }>('/students/bulk-delete', {
          university_id: universityId,
          student_ids: part,
        });
        return { done: res.deleted, failed: res.failed };
      }),
    onSuccess: (outcome) => void finish(outcome, b.deleteDone(outcome.done)),
    onError: (e) => {
      setProgress(null);
      toast.error(errorMessage(e));
    },
  });

  const exporting = useMutation({
    mutationFn: () => exportSelected(ids),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const openPrint = (base: string) => {
    const key = storeSelection(ids);
    navigate(base === 'roster' ? `/admin/roster?university=${universityId}&kind=student&sel=${key}` : `/admin/cards?sel=${key}`);
  };

  const busy = Boolean(progress) || setActive.isPending || remove.isPending;

  return (
    <>
      <div
        className="no-print sticky bottom-0 z-20 -mx-4 mt-4 border-t border-border bg-bg/95 px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] backdrop-blur safe-bottom lg:-mx-6 lg:px-6"
        role="region"
        aria-label={b.actions}
        data-testid="students-bulk-bar"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="num me-1 font-bold" aria-live="polite">
            {progress ? b.working(progress.done, progress.total) : b.selected(n)}
          </span>
          <Button size="sm" variant="ghost" onClick={onClear} disabled={busy}>
            <X className="h-4 w-4" aria-hidden />
            {b.clear}
          </Button>
          <div className="flex flex-wrap gap-2 sm:ms-auto">
            {isAdmin ? (
              <BarButton icon={<PackageIcon className="h-4 w-4" />} onClick={() => setAction('package')} disabled={busy} testId="bulk-package">
                {b.package}
              </BarButton>
            ) : null}
            {can('students') ? (
              <>
                <BarButton icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => setAction('activate')} disabled={busy} testId="bulk-activate">
                  {b.activate}
                </BarButton>
                <BarButton icon={<PauseCircle className="h-4 w-4" />} onClick={() => setAction('deactivate')} disabled={busy} testId="bulk-deactivate">
                  {b.deactivate}
                </BarButton>
              </>
            ) : null}
            {can('notifications') ? (
              <BarButton icon={<Bell className="h-4 w-4" />} onClick={() => setAction('notify')} disabled={busy} testId="bulk-notify">
                {b.notify}
              </BarButton>
            ) : null}
            <BarButton
              icon={<FileSpreadsheet className="h-4 w-4" />}
              onClick={() => exporting.mutate()}
              disabled={busy || exporting.isPending}
              testId="bulk-export-excel"
            >
              {exporting.isPending ? t.common.loading : b.exportExcel}
            </BarButton>
            <BarButton icon={<FileText className="h-4 w-4" />} onClick={() => openPrint('roster')} disabled={busy} testId="bulk-export-pdf">
              {b.exportPdf}
            </BarButton>
            <BarButton icon={<Printer className="h-4 w-4" />} onClick={() => openPrint('cards')} disabled={busy} testId="bulk-print-cards">
              {b.printCards}
            </BarButton>
            {isAdmin ? (
              <BarButton icon={<Trash2 className="h-4 w-4" />} onClick={() => setAction('delete')} disabled={busy} danger testId="bulk-delete">
                {b.delete}
              </BarButton>
            ) : null}
          </div>
        </div>
      </div>

      {action === 'package' ? (
        <PackageDialog
          universityId={universityId}
          ids={ids}
          onClose={() => setAction(null)}
          onProgress={setProgress}
          onDone={(outcome) => void finish(outcome, b.packageDone(outcome.done))}
        />
      ) : null}
      {action === 'activate' || action === 'deactivate' ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && !setActive.isPending && setAction(null)}
          title={action === 'activate' ? b.activate : b.deactivate}
          body={action === 'activate' ? b.activateConfirm(n) : b.deactivateConfirm(n)}
          danger={action === 'deactivate'}
          busy={setActive.isPending}
          onConfirm={() => setActive.mutate(action === 'activate')}
        />
      ) : null}
      {action === 'delete' ? (
        <DeleteDialog count={n} busy={remove.isPending} onClose={() => !remove.isPending && setAction(null)} onConfirm={() => remove.mutate()} />
      ) : null}
      {action === 'notify' ? <NotifyDialog universityId={universityId} ids={ids} onClose={() => setAction(null)} onSent={onClear} /> : null}
      {result ? <ResultDialog result={result} onClose={() => setResult(null)} /> : null}
    </>
  );
}

function BarButton({
  icon,
  children,
  onClick,
  disabled,
  danger,
  testId,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  testId?: string;
}) {
  return (
    <Button size="sm" variant={danger ? 'danger' : 'outline'} onClick={onClick} disabled={disabled} data-testid={testId}>
      <span aria-hidden>{icon}</span>
      {children}
    </Button>
  );
}

function PackageDialog({
  universityId,
  ids,
  onClose,
  onProgress,
  onDone,
}: {
  universityId: string;
  ids: string[];
  onClose: () => void;
  onProgress: (p: Progress | null) => void;
  onDone: (outcome: Outcome) => void;
}) {
  const s = t.admin.students;
  const toast = useToast();
  const packages = usePackages(universityId);
  const [packageId, setPackageId] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [note, setNote] = useState('');
  const fid = { pkg: useId(), start: useId(), end: useId(), note: useId() };
  const pick = (id: string) => {
    setPackageId(id);
    const p = packages.data?.find((x) => x.id === id);
    if (p) {
      setStartsOn(p.semester_start);
      setEndsOn(p.semester_end);
    }
  };
  const save = useMutation({
    mutationFn: () =>
      inChunks(ids, ASSIGN_CHUNK, onProgress, async (part) => {
        const res = unwrap(
          await supabase.rpc('bulk_assign_subscription', {
            p_student_ids: part,
            p_package_id: packageId,
            p_starts_on: startsOn || null,
            p_ends_on: endsOn || null,
            p_note: note.trim() || null,
          }),
        ) as { assigned: number; failed: Failure[] };
        return { done: res.assigned, failed: res.failed };
      }),
    onSuccess: onDone,
    onError: (e) => {
      onProgress(null);
      toast.error(errorMessage(e));
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()} title={s.bulk.packageTitle(ids.length)} description={s.bulk.packageNote}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (packageId) save.mutate();
        }}
      >
        <Field label={t.student.package} htmlFor={fid.pkg}>
          <Select id={fid.pkg} value={packageId} onChange={(e) => pick(e.target.value)} data-testid="bulk-package-select">
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
          <Field label={s.startsOn} htmlFor={fid.start}>
            <Input id={fid.start} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </Field>
          <Field label={s.endsOn} htmlFor={fid.end}>
            <Input id={fid.end} type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </Field>
        </div>
        <Field label={t.common.notes} htmlFor={fid.note}>
          <Textarea id={fid.note} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-3">
          <Button onClick={onClose} disabled={save.isPending}>
            {t.common.cancel}
          </Button>
          <Button type="submit" variant="secondary" disabled={!packageId || save.isPending} data-testid="bulk-package-submit">
            {save.isPending ? t.common.saving : t.common.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Deleting is permanent, so the count must be typed to enable the button. */
function DeleteDialog({ count, busy, onClose, onConfirm }: { count: number; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const b = t.admin.students.bulk;
  const [typed, setTyped] = useState('');
  const fid = useId();
  const matches = typed.trim() === String(count);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={b.deleteTitle(count)}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t.common.cancel}
          </Button>
          <Button variant="danger" disabled={!matches || busy} onClick={onConfirm} data-testid="bulk-delete-confirm">
            {busy ? t.common.saving : b.delete}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-7 text-text">{b.deleteConfirm}</p>
      <Field label={b.deleteTypeLabel} htmlFor={fid}>
        <Input
          id={fid}
          inputMode="numeric"
          dir="ltr"
          autoComplete="off"
          className="num text-start"
          placeholder={String(count)}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          data-testid="bulk-delete-type"
        />
      </Field>
    </Dialog>
  );
}

function NotifyDialog({ universityId, ids, onClose, onSent }: { universityId: string; ids: string[]; onClose: () => void; onSent: () => void }) {
  const b = t.admin.students.bulk;
  const n = t.admin.notifications;
  const toast = useToast();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const fid = { title: useId(), body: useId() };
  const send = useMutation({
    mutationFn: () =>
      api.post<{ recipients: number }>('/notifications/broadcast', {
        university_id: universityId,
        title: title.trim(),
        body: body.trim(),
        audience: { kind: 'students', student_ids: ids },
      }),
    onSuccess: (res) => {
      toast.success(n.sent(res.recipients));
      void qc.invalidateQueries({ queryKey: ['broadcasts', universityId] });
      onClose();
      onSent();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const valid = Boolean(title.trim() && body.trim());
  return (
    <Dialog open onOpenChange={(o) => !o && !send.isPending && onClose()} title={b.notifyTitle(ids.length)} description={b.notifyNote}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) send.mutate();
        }}
      >
        <Field label={n.titleField} htmlFor={fid.title}>
          <Input id={fid.title} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} data-testid="bulk-notify-title" />
        </Field>
        <Field label={n.body} htmlFor={fid.body}>
          <Textarea id={fid.body} value={body} maxLength={1000} onChange={(e) => setBody(e.target.value)} data-testid="bulk-notify-body" />
        </Field>
        <div className="flex justify-end gap-3">
          <Button onClick={onClose} disabled={send.isPending}>
            {t.common.cancel}
          </Button>
          <Button type="submit" variant="secondary" disabled={!valid || send.isPending} data-testid="bulk-notify-send">
            <Bell className="h-4 w-4" aria-hidden />
            {send.isPending ? t.common.saving : n.send}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ResultDialog({ result, onClose }: { result: { done: number; failed: DescribedFailure[]; total: number }; onClose: () => void }) {
  const b = t.admin.students.bulk;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={b.resultTitle}
      description={<span className="num">{b.resultSummary(result.done, result.total)}</span>}
      footer={<Button onClick={onClose}>{t.common.close}</Button>}
    >
      <ul className="divide-y divide-border text-sm" data-testid="bulk-result-failures">
        {result.failed.map((f) => (
          <li key={f.student_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              {f.student ? (
                <>
                  <span className="num font-mono">{f.student.transport_number}</span> · {f.student.full_name}
                </>
              ) : (
                b.unknownStudent
              )}
            </span>
            <span className="text-danger">{b.failedReason[f.code] ?? t.errors[f.code] ?? f.code}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
