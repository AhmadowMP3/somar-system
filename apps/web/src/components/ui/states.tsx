import { AlertTriangle, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '@/i18n/ar';
import { errorMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { Button, Card, Skeleton } from './primitives';

export function EmptyState({ title, hint, action }: { title: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-6 py-10 text-center">
      <Inbox className="h-10 w-10 text-brand-silver" aria-hidden />
      <p className="font-bold">{title}</p>
      {hint ? <p className="max-w-sm text-sm text-muted">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error?: unknown; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-2 rounded-xl border border-danger/30 bg-danger/5 px-6 py-8 text-center"
    >
      <AlertTriangle className="h-9 w-9 text-danger" aria-hidden />
      <p className="font-bold">{t.common.errorTitle}</p>
      <p className="max-w-sm text-sm text-muted">{error ? errorMessage(error) : t.common.errorBody}</p>
      {onRetry ? (
        <Button className="mt-2" onClick={onRetry}>
          {t.common.retry}
        </Button>
      ) : null}
    </div>
  );
}

export function ListSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-3', className)} aria-busy="true" aria-label={t.common.loading}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}

export function CardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-busy="true" aria-label={t.common.loading}>
      {Array.from({ length: count }, (_, i) => (
        <Card key={i}>
          <Skeleton className="mb-2 h-4 w-2/3" />
          <Skeleton className="h-8 w-1/2" />
        </Card>
      ))}
    </div>
  );
}

/** Standard loading / error / empty switch for a query result. */
export function QueryState<T>({
  query,
  empty,
  skeleton,
  children,
}: {
  query: { isLoading: boolean; isError: boolean; error: unknown; data: T | undefined; refetch: () => unknown };
  empty?: (data: T) => ReactNode | null;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (query.isLoading) return <>{skeleton ?? <ListSkeleton />}</>;
  if (query.isError || query.data === undefined) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const emptyNode = empty?.(query.data);
  if (emptyNode) return <>{emptyNode}</>;
  return <>{children(query.data)}</>;
}

export function PageHeader({ title, actions, subtitle }: { title: ReactNode; actions?: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-xl font-extrabold text-brand-ink">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export type Column<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  /** Hide from the mobile card body (e.g. when used as the card title). */
  mobileHidden?: boolean;
};

/** Table on ≥768px, stacked cards below. */
export function DataList<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  cardTitle,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  cardTitle?: (row: T) => ReactNode;
}) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border border-border md:block">
        <table className="w-full text-sm">
          <thead className="bg-surface text-start text-xs text-muted">
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn('px-3 py-2 text-start font-semibold', c.className)}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={cn('border-t border-border', onRowClick && 'cursor-pointer hover:bg-surface')}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} className={cn('px-3 py-2 align-middle', c.className)}>
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-3 md:hidden">
        {rows.map((row) => (
          <li key={rowKey(row)}>
            <Card
              className={cn('p-3', onRowClick && 'cursor-pointer active:bg-surface')}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {cardTitle ? <div className="mb-2 font-bold">{cardTitle(row)}</div> : null}
              <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
                {columns
                  .filter((c) => !c.mobileHidden)
                  .map((c) => (
                    <div key={c.key} className="contents">
                      <dt className="text-muted">{c.header}</dt>
                      <dd className="min-w-0 break-words">{c.cell(row)}</dd>
                    </div>
                  ))}
              </dl>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
