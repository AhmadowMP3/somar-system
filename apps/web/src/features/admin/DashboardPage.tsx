import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatDate } from '@somar/shared';
import { useScope } from '@/app/auth';
import { useToast } from '@/components/ui/overlay';
import { Button, Card, CardTitle } from '@/components/ui/primitives';
import { CardsSkeleton, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { useIsAdmin } from './common';

type DashboardData = {
  students_total: number;
  students_active: number;
  scans_today_outbound: number;
  scans_today_return: number;
  students_no_balance: number;
  subscriptions_expiring: number;
  students_no_photo: number;
  needs_area_mapping: number;
  chart: { day: string; outbound: number; return: number }[];
};

function Kpi({ label, value, to }: { label: string; value: React.ReactNode; to?: string }) {
  const body = (
    <Card className="h-full">
      <p className="text-sm text-muted">{label}</p>
      <p className="num mt-1 text-3xl font-extrabold text-brand-ink">{value}</p>
    </Card>
  );
  return to ? (
    <Link to={to} className="block rounded-xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-ink/30">
      {body}
    </Link>
  ) : (
    body
  );
}

function ScanChart({ data }: { data: DashboardData['chart'] }) {
  const max = Math.max(1, ...data.map((d) => d.outbound + d.return));
  const w = 36;
  const gap = 16;
  const h = 160;
  const width = data.length * (w + gap);
  return (
    <figure>
      <svg viewBox={`0 0 ${width} ${h + 36}`} className="h-56 w-full" role="img" aria-label={t.admin.dashboard.chartTitle}>
        {data.map((d, i) => {
          const x = (data.length - 1 - i) * (w + gap) + gap / 2;
          const ho = (d.outbound / max) * h;
          const hr = (d.return / max) * h;
          return (
            <g key={d.day}>
              <rect x={x} y={h - ho} width={w} height={ho} rx={3} fill="var(--brand-ink)">
                <title>{`${t.student.outbound}: ${d.outbound}`}</title>
              </rect>
              <rect x={x} y={h - ho - hr} width={w} height={hr} rx={3} fill="var(--success)">
                <title>{`${t.student.return}: ${d.return}`}</title>
              </rect>
              <text x={x + w / 2} y={h + 16} textAnchor="middle" fontSize="11" fill="var(--text-muted)">
                {formatDate(d.day).slice(0, 5)}
              </text>
              <text x={x + w / 2} y={h + 30} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--text)">
                {d.outbound + d.return}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 flex gap-4 text-xs">
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm bg-brand-ink" /> {t.student.outbound}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm bg-success" /> {t.student.return}
        </span>
      </figcaption>
    </figure>
  );
}

export default function DashboardPage() {
  const { universityId } = useScope();
  const isAdmin = useIsAdmin();
  const toast = useToast();
  const query = useQuery({
    queryKey: ['admin-dashboard', universityId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_dashboard', { p_university_id: universityId });
      if (error) throw error;
      return data as DashboardData;
    },
  });
  const daily = useMutation({
    mutationFn: () => api.post('/jobs/daily?force=true'),
    onSuccess: () => {
      toast.success(t.admin.dashboard.dailyDone);
      void query.refetch();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const d = t.admin.dashboard;
  return (
    <div>
      <PageHeader
        title={d.title}
        actions={
          isAdmin ? (
            <Button size="sm" onClick={() => daily.mutate()} disabled={daily.isPending}>
              {d.runDaily}
            </Button>
          ) : undefined
        }
      />
      <QueryState query={query} skeleton={<CardsSkeleton count={8} />}>
        {(data) => (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Kpi label={d.students} value={data.students_total} to="/admin/students" />
              <Kpi label={d.activeStudents} value={data.students_active} to="/admin/students" />
              <Kpi
                label={d.scansToday}
                value={
                  <>
                    {data.scans_today_outbound}
                    <span className="text-muted"> / </span>
                    {data.scans_today_return}
                  </>
                }
                to="/admin/scans"
              />
              <Kpi label={d.noBalance} value={data.students_no_balance} to="/admin/students?balance=zero" />
              <Kpi label={d.expiring} value={data.subscriptions_expiring} />
              <Kpi label={d.noPhoto} value={data.students_no_photo} to="/admin/students?photo=no" />
              <Kpi label={d.needsMapping} value={data.needs_area_mapping} to="/admin/areas/mapping" />
            </div>
            <Card>
              <CardTitle>{d.chartTitle}</CardTitle>
              <ScanChart data={data.chart ?? []} />
            </Card>
          </div>
        )}
      </QueryState>
    </div>
  );
}
