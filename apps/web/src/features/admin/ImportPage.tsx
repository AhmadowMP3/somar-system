import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, FileSpreadsheet, MapPinned } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { IMPORT_FIELDS, type HeaderMapping, type ImportFieldKey, type ImportSummary } from '@somar/shared';
import { Badge, Button, Card, CardTitle, Field, Input, Select } from '@/components/ui/primitives';
import { DataList, PageHeader } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { api, ApiClientError } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { exportSheet } from '@/lib/exportSheet';
import { cn } from '@/lib/utils';
import { defaultPicks, ImportPickBar, ImportPickBox, WithUniversity } from './common';

type ImportRow = {
  row_number: number;
  status: 'created' | 'updated' | 'duplicate' | 'rejected';
  student_name: string;
  university_student_no: string | null;
  package_name: string | null;
  transport_number?: string | null;
  reasons: string[];
  warnings: string[];
};
type ImportResponse = {
  summary: ImportSummary;
  packages: { name: string | null; count: number }[];
  rows: ImportRow[];
  headers: string[];
  mapping: HeaderMapping;
  needs_area_mapping: number;
  dry_run: boolean;
};

const STATUS_TONE = { created: 'success', updated: 'info', duplicate: 'neutral', rejected: 'danger' } as const;

export default function ImportPage() {
  return <WithUniversity>{(universityId) => <ImportWizard key={universityId} universityId={universityId} />}</WithUniversity>;
}

function ImportWizard({ universityId }: { universityId: string }) {
  const im = t.admin.import;
  const qc = useQueryClient();
  const fileId = useId();
  const [step, setStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<HeaderMapping>({});
  const [preview, setPreview] = useState<ImportResponse | null>(null);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const call = (dryRun: boolean, map?: HeaderMapping, rows?: number[]) => {
    const form = new FormData();
    form.append('university_id', universityId);
    form.append('dry_run', String(dryRun));
    if (map) form.append('mapping', JSON.stringify(map));
    if (rows) form.append('rows', JSON.stringify(rows));
    form.append('file', file as File);
    return api.post<ImportResponse>('/students/import', form);
  };

  const analyze = useMutation({
    mutationFn: () => call(true),
    onSuccess: (res) => {
      setError(null);
      setHeaders(res.headers);
      setMapping(res.mapping);
      setPreview(res);
      setStep(1);
    },
    onError: (e) => {
      if (e instanceof ApiClientError && e.code === 'MISSING_COLUMN') {
        const details = e.details as { headers: string[]; mapping: HeaderMapping };
        setHeaders(details.headers);
        setMapping(details.mapping);
        setStep(1);
      }
      setError(errorMessage(e));
    },
  });
  const runPreview = useMutation({
    mutationFn: () => call(true, mapping),
    onSuccess: (res) => {
      setError(null);
      setPreview(res);
      setPicked(defaultPicks(res.rows));
      setStep(2);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const commit = useMutation({
    mutationFn: () => call(false, mapping, [...picked]),
    onSuccess: (res) => {
      setError(null);
      setResult(res);
      setStep(3);
      void qc.invalidateQueries();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const missingRequired = IMPORT_FIELDS.some((f) => f.required && !mapping[f.key]);
  const shown = result ?? preview;
  const rows = useMemo(() => (shown?.rows ?? []).filter((r) => !filter || r.status === filter), [shown, filter]);
  // rejected rows cannot be picked, so the commit result usually has none: keep the preview's for the export
  const rejected = useMemo(
    () => (result?.summary.rejected ? result : preview)?.rows.filter((r) => r.status === 'rejected') ?? [],
    [result, preview],
  );

  const exportRejected = () => {
    exportSheet(
      im.rejectedFileName,
      rejected.map((r) => ({
        [im.row]: r.row_number,
        [t.student.fullName]: r.student_name,
        [t.student.universityNo]: r.university_student_no ?? '',
        [im.reasons]: r.reasons.join(' | '),
      })),
    );
  };

  return (
    <div className="space-y-4">
      <PageHeader title={im.title} />
      <ol className="flex flex-wrap gap-3" aria-label={im.title}>
        {im.steps.map((label, i) => (
          <li
            key={label}
            aria-current={i === step ? 'step' : undefined}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-bold',
              i === step ? 'bg-brand-ink text-on-ink' : i < step ? 'bg-success/15 text-success' : 'bg-surface text-muted',
            )}
          >
            <span className="num">{i + 1}</span>. {label}
          </li>
        ))}
      </ol>
      {error ? (
        <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}

      {step === 0 ? (
        <Card className="space-y-4">
          <Field label={im.upload} htmlFor={fileId} hint={im.uploadHint}>
            <Input
              id={fileId}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              data-testid="import-file"
            />
          </Field>
          <Button variant="secondary" disabled={!file || analyze.isPending} onClick={() => analyze.mutate()} data-testid="import-analyze">
            <FileSpreadsheet className="h-4 w-4" aria-hidden />
            {analyze.isPending ? im.analyzing : im.analyze}
          </Button>
        </Card>
      ) : null}

      {step === 1 ? (
        <Card className="space-y-4">
          <CardTitle>{im.mappingTitle}</CardTitle>
          <p className="text-sm text-muted">{im.mappingIntro}</p>
          <div className="grid gap-3 md:grid-cols-2">
            {IMPORT_FIELDS.map((f) => (
              <MappingRow
                key={f.key}
                field={f.key}
                required={f.required}
                headers={headers}
                value={mapping[f.key] ?? ''}
                onChange={(v) => setMapping((m) => ({ ...m, [f.key]: v }))}
              />
            ))}
          </div>
          {missingRequired ? <p className="text-sm font-semibold text-danger">{im.requiredMissing}</p> : null}
          <div className="flex justify-between gap-2">
            <Button onClick={() => setStep(0)}>{t.common.back}</Button>
            <Button variant="secondary" disabled={missingRequired || runPreview.isPending} onClick={() => runPreview.mutate()} data-testid="import-preview">
              {runPreview.isPending ? im.analyzing : im.preview}
            </Button>
          </div>
        </Card>
      ) : null}

      {(step === 2 || step === 3) && shown ? (
        <>
          {step === 3 ? (
            <Card className="space-y-3 border-success/40">
              <CardTitle>{im.resultTitle}</CardTitle>
              {shown.needs_area_mapping > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-warning/10 p-3" data-testid="mapping-banner">
                  <span className="flex items-center gap-2 text-sm font-semibold text-warning">
                    <MapPinned className="h-4 w-4" aria-hidden />
                    {im.mappingBanner(shown.needs_area_mapping)}
                  </span>
                  <Button asChild size="sm">
                    <Link to="/admin/areas/mapping">{im.goMapping}</Link>
                  </Button>
                </div>
              ) : null}
            </Card>
          ) : null}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="import-counters">
            <Counter label={im.counters.total} value={shown.summary.total} active={filter === ''} onClick={() => setFilter('')} testId="count-total" />
            <Counter label={im.counters.created} value={shown.summary.created} active={filter === 'created'} onClick={() => setFilter('created')} testId="count-created" />
            <Counter label={im.counters.updated} value={shown.summary.updated} active={filter === 'updated'} onClick={() => setFilter('updated')} testId="count-updated" />
            <Counter label={im.counters.duplicates} value={shown.summary.duplicates} active={filter === 'duplicate'} onClick={() => setFilter('duplicate')} testId="count-duplicates" />
            <Counter label={im.counters.rejected} value={shown.summary.rejected} active={filter === 'rejected'} onClick={() => setFilter('rejected')} testId="count-rejected" />
          </div>
          {shown.packages?.length ? (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-bg p-3 text-sm" data-testid="import-packages">
              <span className="font-bold">{im.packagesTitle}</span>
              {shown.packages.map((p) => (
                <Badge key={p.name ?? 'none'} tone={p.name ? 'info' : 'warning'}>
                  {p.name ?? im.noPackage}: <span className="num">{p.count}</span>
                </Badge>
              ))}
            </div>
          ) : null}
          {step === 2 ? <ImportPickBar rows={shown.rows} picked={picked} onChange={setPicked} /> : null}
          <DataList
            rows={rows}
            rowKey={(r) => String(r.row_number)}
            cardTitle={(r) => (
              <span className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  {step === 2 ? <ImportPickBox row={r} name={r.student_name} picked={picked} onChange={setPicked} /> : null}
                  {r.student_name || t.common.none}
                </span>
                <Badge tone={STATUS_TONE[r.status]}>{im.status[r.status]}</Badge>
              </span>
            )}
            columns={[
              ...(step === 2
                ? [
                    {
                      key: 'pick',
                      header: im.pick,
                      cell: (r: ImportRow) => <ImportPickBox row={r} name={r.student_name} picked={picked} onChange={setPicked} />,
                      mobileHidden: true,
                    },
                  ]
                : []),
              { key: 'row', header: im.row, cell: (r) => <span className="num">{r.row_number}</span> },
              { key: 'status', header: t.common.status, cell: (r) => <Badge tone={STATUS_TONE[r.status]}>{im.status[r.status]}</Badge>, mobileHidden: true },
              { key: 'name', header: t.common.name, cell: (r) => r.student_name, mobileHidden: true },
              { key: 'no', header: t.student.universityNo, cell: (r) => <span className="num">{r.university_student_no ?? t.common.none}</span> },
              {
                key: 'package',
                header: t.student.package,
                cell: (r) => (r.status === 'rejected' || r.status === 'duplicate' ? null : (r.package_name ?? <span className="text-warning">{im.noPackage}</span>)),
              },
              {
                key: 'reasons',
                header: im.reasons,
                cell: (r) => (
                  <ul className="space-y-0.5 text-xs">
                    {r.reasons.map((x) => (
                      <li key={x} className="text-danger">
                        {x}
                      </li>
                    ))}
                    {r.warnings.map((x) => (
                      <li key={x} className="text-warning">
                        {x}
                      </li>
                    ))}
                  </ul>
                ),
              },
            ]}
          />
          <div className="sticky bottom-0 flex flex-wrap justify-between gap-2 border-t border-border bg-surface py-3">
            {step === 2 ? (
              <>
                <Button onClick={() => setStep(1)}>{t.common.back}</Button>
                <Button variant="primary" disabled={commit.isPending || picked.size === 0} onClick={() => commit.mutate()} data-testid="import-commit">
                  {commit.isPending ? im.committing : im.commitPicked(picked.size)}
                </Button>
              </>
            ) : (
              <>
                <Button
                  onClick={() => {
                    setStep(0);
                    setFile(null);
                    setPreview(null);
                    setResult(null);
                  }}
                >
                  {im.again}
                </Button>
                <div className="flex flex-wrap gap-2">
                  <Button asChild>
                    <Link to="/admin/students/new">{im.fixManually}</Link>
                  </Button>
                  <Button
                    onClick={() =>
                      exportSheet(
                        t.admin.exportNamesFile.student,
                        shown.rows
                          .filter((r) => r.transport_number)
                          .map((r) => ({ [t.common.name]: r.student_name, [t.student.transportNumber]: r.transport_number })),
                      )
                    }
                    data-testid="import-export-names"
                  >
                    <Download className="h-4 w-4" aria-hidden />
                    {t.admin.exportNames}
                  </Button>
                  <Button variant="secondary" disabled={rejected.length === 0} onClick={exportRejected} data-testid="export-rejected">
                    <Download className="h-4 w-4" aria-hidden />
                    {im.exportRejected}
                  </Button>
                </div>
              </>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

function Counter({ label, value, active, onClick, testId }: { label: string; value: number; active: boolean; onClick: () => void; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn('rounded-xl border p-3 text-start', active ? 'border-brand-ink bg-brand-ink/5' : 'border-border bg-bg')}
    >
      <span className="block text-xs text-muted">{label}</span>
      <span className="num block text-2xl font-extrabold" data-testid={testId}>
        {value}
      </span>
    </button>
  );
}

function MappingRow({ field, required, headers, value, onChange }: {
  field: ImportFieldKey;
  required: boolean;
  headers: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  const im = t.admin.import;
  return (
    <Field label={`${im.fields[field] ?? field}${required ? ' *' : ''}`} htmlFor={id}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={required && !value ? 'border-danger' : undefined}>
        <option value="">{im.notMapped}</option>
        {headers.filter(Boolean).map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </Select>
    </Field>
  );
}
