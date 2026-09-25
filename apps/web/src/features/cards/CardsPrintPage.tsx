import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Printer } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { formatDate } from '@somar/shared';
import { QrCode } from '@/components/QrCode';
import { Button, Select } from '@/components/ui/primitives';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { LOGO_BUCKET, PHOTO_BUCKET, signedUrl, supabase, unwrap } from '@/lib/supabase';

type CardData = {
  id: string;
  full_name: string;
  transport_number: string;
  qr_token: string;
  college: string;
  package_name: string | null;
  ends_on: string | null;
  photo: string | null;
  logo: string | null;
};

async function toDataUri(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function loadCards(params: URLSearchParams): Promise<CardData[]> {
  let q = supabase
    .from('students')
    .select('id, full_name, transport_number, qr_token, photo_path, university_id, colleges(name), universities(logo_path)')
    .eq('is_active', true)
    .order('transport_number');
  const ids = params.get('ids');
  const pkg = params.get('package');
  const college = params.get('college');
  const university = params.get('university');
  if (ids) q = q.in('id', ids.split(',').filter(Boolean));
  else if (pkg) {
    const subs = unwrap(await supabase.from('subscriptions').select('student_id').eq('package_id', pkg).eq('status', 'active')) as {
      student_id: string;
    }[];
    q = q.in('id', subs.map((s) => s.student_id));
  } else if (college) q = q.eq('college_id', college);
  else if (university) q = q.eq('university_id', university);
  else return [];

  const students = unwrap(await q) as unknown as {
    id: string;
    full_name: string;
    transport_number: string;
    qr_token: string;
    photo_path: string | null;
    colleges: { name: string } | null;
    universities: { logo_path: string | null } | null;
  }[];
  if (!students.length) return [];

  const balances = unwrap(
    await supabase
      .from('v_student_balance')
      .select('student_id, package_name, subscription_ends_on')
      .in('student_id', students.map((s) => s.id)),
  ) as { student_id: string; package_name: string | null; subscription_ends_on: string | null }[];
  const byId = new Map(balances.map((b) => [b.student_id, b]));

  const logoCache = new Map<string, Promise<string | null>>();
  const logoFor = (path: string | null | undefined) => {
    if (!path) return Promise.resolve(null);
    if (!logoCache.has(path)) logoCache.set(path, signedUrl(LOGO_BUCKET, path).then(toDataUri));
    return logoCache.get(path) as Promise<string | null>;
  };

  return Promise.all(
    students.map(async (s) => ({
      id: s.id,
      full_name: s.full_name,
      transport_number: s.transport_number,
      qr_token: s.qr_token,
      college: s.colleges?.name ?? '',
      package_name: byId.get(s.id)?.package_name ?? null,
      ends_on: byId.get(s.id)?.subscription_ends_on ?? null,
      photo: await toDataUri(await signedUrl(PHOTO_BUCKET, s.photo_path)),
      logo: await logoFor(s.universities?.logo_path),
    })),
  );
}

const PRINT_CSS = {
  sheet: `@page { size: A4; margin: 8mm; }`,
  single: `@page { size: 85.6mm 54mm; margin: 0; }`,
};

function TransportCard({ card }: { card: CardData }) {
  return (
    <article
      className="transport-card relative flex overflow-hidden rounded-[3mm] border border-border bg-white text-[#14181D]"
      style={{ width: '85.6mm', height: '54mm' }}
      data-testid="transport-card"
    >
      <div className="absolute inset-x-0 top-0 h-[2.2mm] bg-brand" aria-hidden />
      <div className="flex flex-1 flex-col p-[3mm] pt-[4mm]">
        <div className="mb-[1.5mm] flex items-center gap-[2mm]">
          {card.logo ? <img src={card.logo} alt="" className="h-[7mm] w-[7mm] object-contain" /> : null}
          <img src="/icons/logo.svg" alt="" className="h-[7mm] w-auto" />
          <span className="text-[2.4mm] font-bold leading-tight text-brand-ink">{t.cards.transportCard}</span>
        </div>
        <div className="flex flex-1 gap-[2.5mm]">
          <div className="h-[22mm] w-[18mm] shrink-0 overflow-hidden rounded-[1.5mm] bg-surface">
            {card.photo ? <img src={card.photo} alt="" className="h-full w-full object-cover" data-testid="card-photo" /> : null}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="text-[3.2mm] font-extrabold">{card.full_name}</p>
            <p className="mt-[1mm] text-[2.4mm] text-[#5B646E]">{card.college}</p>
            <p className="mt-[0.6mm] text-[2.4mm] text-[#5B646E]">{card.package_name ?? t.cards.noPackage}</p>
          </div>
        </div>
        <div className="flex items-end justify-between">
          <p className="num font-mono text-[5mm] font-extrabold tracking-wider text-brand-ink" dir="ltr">
            {card.transport_number}
          </p>
        </div>
        {card.ends_on ? <p className="text-[2.3mm] font-semibold">{t.student.validUntil(formatDate(card.ends_on))}</p> : null}
      </div>
      <div className="flex w-[25mm] shrink-0 items-center justify-center p-[1mm]">
        <QrCode token={card.qr_token} className="h-[23mm] w-[23mm]" label={card.transport_number} />
      </div>
    </article>
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export default function CardsPrintPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'sheet' | 'single'>(params.get('mode') === 'single' ? 'single' : 'sheet');
  const query = useQuery({
    queryKey: ['cards', params.toString()],
    queryFn: () => loadCards(params),
    staleTime: 0,
  });
  const cards = query.data ?? [];

  return (
    <div className="min-h-dvh bg-surface print:bg-white">
      <style>{`${PRINT_CSS[mode]}
        @media print {
          .sheet { box-shadow: none !important; margin: 0 !important; }
          .sheet + .sheet, .single-page + .single-page { break-before: page; }
        }
        .crop { position: relative; }
        .crop::before, .crop::after { content: ''; position: absolute; inset: -3mm; pointer-events: none;
          background:
            linear-gradient(#9aa0a6,#9aa0a6) left 0 top 3mm / 2.5mm 0.2mm no-repeat,
            linear-gradient(#9aa0a6,#9aa0a6) right 0 top 3mm / 2.5mm 0.2mm no-repeat,
            linear-gradient(#9aa0a6,#9aa0a6) left 0 bottom 3mm / 2.5mm 0.2mm no-repeat,
            linear-gradient(#9aa0a6,#9aa0a6) right 0 bottom 3mm / 2.5mm 0.2mm no-repeat,
            linear-gradient(#9aa0a6,#9aa0a6) left 3mm top 0 / 0.2mm 2.5mm no-repeat,
            linear-gradient(#9aa0a6,#9aa0a6) right 3mm top 0 / 0.2mm 2.5mm no-repeat,
            linear-gradient(#9aa0a6,#9aa0a6) left 3mm bottom 0 / 0.2mm 2.5mm no-repeat,
            linear-gradient(#9aa0a6,#9aa0a6) right 3mm bottom 0 / 0.2mm 2.5mm no-repeat; }
      `}</style>
      <div className="no-print sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-bg p-3">
        <Button variant="ghost" onClick={() => navigate(-1)}>
          <ArrowRight className="h-4 w-4" aria-hidden />
          {t.common.back}
        </Button>
        <h1 className="text-lg font-extrabold">{t.cards.title}</h1>
        <span className="text-sm text-muted">{t.cards.count(cards.length)}</span>
        <Select aria-label={t.cards.mode} className="ms-auto w-auto" value={mode} onChange={(e) => setMode(e.target.value as 'sheet' | 'single')}>
          <option value="sheet">{t.cards.sheet}</option>
          <option value="single">{t.cards.single}</option>
        </Select>
        <Button variant="secondary" disabled={query.isLoading || !cards.length} onClick={() => window.print()}>
          <Printer className="h-4 w-4" aria-hidden />
          {t.common.print}
        </Button>
        <p className="w-full text-xs text-muted">{t.cards.printHint}</p>
      </div>
      {query.isLoading ? (
        <div className="p-6">
          <p className="mb-3 text-sm text-muted" role="status">
            {t.cards.preparing}
          </p>
          <ListSkeleton rows={3} />
        </div>
      ) : query.isError ? (
        <div className="p-6">
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </div>
      ) : !cards.length ? (
        <div className="p-6">
          <EmptyState title={t.cards.empty} />
        </div>
      ) : mode === 'sheet' ? (
        <div className="flex flex-col items-center gap-6 overflow-x-auto p-4 print:block print:p-0" data-ready="true">
          {chunk(cards, 10).map((page, i) => (
            <section
              key={i}
              className="sheet grid bg-white shadow-lg"
              style={{
                width: '194mm',
                height: '281mm',
                gridTemplateColumns: 'repeat(2, 85.6mm)',
                gridTemplateRows: 'repeat(5, 54mm)',
                columnGap: '8mm',
                rowGap: '2.5mm',
                justifyContent: 'center',
                alignContent: 'center',
              }}
              data-testid="print-sheet"
            >
              {page.map((card) => (
                <div key={card.id} className="crop">
                  <TransportCard card={card} />
                </div>
              ))}
            </section>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 p-4 print:block print:p-0" data-ready="true">
          {cards.map((card) => (
            <div key={card.id} className="single-page">
              <TransportCard card={card} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
