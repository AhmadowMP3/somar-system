import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Printer } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { damascusDate, formatDate } from '@somar/shared';
import { fetchRiderNames, type RiderKind } from '@/features/admin/common';
import { Button } from '@/components/ui/primitives';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { supabase, unwrap } from '@/lib/supabase';

/** Brand colours, fixed so the PDF looks the same whatever theme the screen uses. */
const BRAND = { red: '#C1121F', ink: '#2B2F36', silver: '#C9CDD3', zebra: '#F4F5F7' };

const PRINT_CSS = `
  @page { size: A4; margin: 14mm 12mm 16mm; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; background: #fff !important; }
    .roster-sheet { box-shadow: none !important; margin: 0 !important; padding: 0 !important; width: auto !important; }
  }
  .roster-table thead { display: table-header-group; }
  .roster-table tr { break-inside: avoid; }
`;

/**
 * Names and transport numbers of every student, doctor or employee as a branded A4 sheet;
 * «حفظ كملف PDF» in the print dialog turns it into the PDF (browsers shape Arabic correctly).
 */
export default function RosterPrintPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const universityId = params.get('university') ?? '';
  const kind = (['student', 'doctor', 'employee'].includes(params.get('kind') ?? '') ? params.get('kind') : 'student') as RiderKind;
  const r = t.roster;

  const query = useQuery({
    queryKey: ['roster', universityId, kind],
    enabled: Boolean(universityId),
    staleTime: 0,
    queryFn: async () => {
      const [rows, uni] = await Promise.all([
        fetchRiderNames(universityId, kind),
        supabase.from('universities').select('name').eq('id', universityId).single(),
      ]);
      return { rows, university: (unwrap(uni) as { name: string }).name };
    },
  });
  const today = formatDate(damascusDate());

  return (
    <div className="min-h-dvh bg-surface print:bg-white" dir="rtl">
      <style>{PRINT_CSS}</style>
      <div className="no-print sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-bg p-3">
        <Button variant="ghost" onClick={() => navigate(-1)}>
          <ArrowRight className="h-4 w-4" aria-hidden />
          {t.common.back}
        </Button>
        <h1 className="text-lg font-extrabold">{r.title[kind]}</h1>
        {query.data ? <span className="text-sm text-muted">{r.count(query.data.rows.length)}</span> : null}
        <Button variant="secondary" className="ms-auto" disabled={!query.data?.rows.length} onClick={() => window.print()} data-testid="roster-print">
          <Printer className="h-4 w-4" aria-hidden />
          {r.savePdf}
        </Button>
        <p className="w-full text-xs text-muted">{t.cards.printHint}</p>
      </div>

      {query.isLoading ? (
        <div className="p-6">
          <ListSkeleton rows={4} />
        </div>
      ) : query.isError ? (
        <div className="p-6">
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </div>
      ) : !query.data?.rows.length ? (
        <div className="p-6">
          <EmptyState title={r.empty} />
        </div>
      ) : (
        <div className="flex justify-center p-4 print:block print:p-0">
          <article
            className="roster-sheet w-[210mm] max-w-full bg-white p-[12mm] text-[11pt] shadow-md"
            style={{ color: BRAND.ink }}
            data-ready="true"
          >
            <header className="mb-5 flex items-center justify-between gap-4 pb-4" style={{ borderBottom: `3px solid ${BRAND.red}` }}>
              <div className="min-w-0">
                <p className="text-[9pt] font-bold tracking-wide" style={{ color: BRAND.red }}>
                  {t.brand}
                </p>
                <h2 className="mt-1 text-[18pt] font-extrabold leading-tight">{r.title[kind]}</h2>
                <p className="mt-1 text-[10pt]">{query.data.university}</p>
              </div>
              <img src="/icons/logo.png" alt={t.brand} className="h-[22mm] w-auto shrink-0" />
            </header>

            <div className="mb-3 flex flex-wrap justify-between gap-2 text-[9pt]" style={{ color: '#5B616B' }}>
              <span>
                {r.date}: <span className="num">{today}</span>
              </span>
              <span>{r.count(query.data.rows.length)}</span>
            </div>

            <table className="roster-table w-full border-collapse text-start" data-testid="roster-table">
              <thead>
                <tr style={{ background: BRAND.red, color: '#fff' }}>
                  <th className="w-[14mm] px-3 py-2 text-center text-[10pt] font-bold">#</th>
                  <th className="px-3 py-2 text-start text-[10pt] font-bold">{t.common.name}</th>
                  <th className="w-[42mm] px-3 py-2 text-center text-[10pt] font-bold">{t.student.transportNumber}</th>
                </tr>
              </thead>
              <tbody>
                {query.data.rows.map((row, i) => (
                  <tr key={row.transport_number} style={{ background: i % 2 ? BRAND.zebra : '#fff', borderBottom: `1px solid ${BRAND.silver}` }}>
                    <td className="num px-3 py-1.5 text-center text-[9pt]" style={{ color: '#5B616B' }}>
                      {i + 1}
                    </td>
                    <td className="px-3 py-1.5 font-semibold">{row.full_name}</td>
                    <td className="num px-3 py-1.5 text-center font-mono font-bold tracking-wider" dir="ltr">
                      {row.transport_number}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <footer
              className="mt-6 flex justify-between pt-2 text-[8pt]"
              style={{ borderTop: `1px solid ${BRAND.silver}`, color: '#5B616B' }}
            >
              <span>
                {t.brand} · {query.data.university}
              </span>
              <span className="num">{today}</span>
            </footer>
          </article>
        </div>
      )}
    </div>
  );
}
