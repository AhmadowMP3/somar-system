import { useQuery } from '@tanstack/react-query';
import { Bell, Download, Share, WifiOff, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { t } from '@/i18n/ar';
import { useAuth, useScope } from '@/app/auth';
import { isIos, isStandalone, safeStorage } from '@/lib/pwa';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { Button, Select } from './ui/primitives';

export function Logo({ className }: { className?: string }) {
  return <img src="/icons/logo.png" alt={t.brand} className={cn('h-9 w-auto', className)} />;
}

/** Vendor credit at the bottom of every screen; hidden when printing (cards, sheets). */
export function CreditFooter({ className }: { className?: string }) {
  return (
    <footer dir="ltr" className={cn('no-print py-4 text-center text-xs text-muted', className)} data-testid="credit-footer">
      {t.poweredBy}
    </footer>
  );
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div role="status" className="flex items-center justify-center gap-2 bg-brand-ink px-4 py-2 text-sm text-white">
      <WifiOff className="h-4 w-4" aria-hidden />
      {t.offline.banner}
    </div>
  );
}

export function useUnreadCount() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['unread-count'],
    enabled: Boolean(session),
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('unread_notifications_count');
      if (error) throw error;
      return (data as number) ?? 0;
    },
  });
}

export function NotificationBell({ to }: { to: string }) {
  const { data } = useUnreadCount();
  const count = data ?? 0;
  return (
    <Link
      to={to}
      className="relative inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-surface"
      aria-label={`${t.nav.notifications}${count ? ` (${count})` : ''}`}
    >
      <Bell className="h-6 w-6 text-brand-ink" aria-hidden />
      {count > 0 ? (
        <span className="num absolute -top-0.5 end-0.5 min-w-[20px] rounded-full bg-brand px-1 text-center text-[11px] font-bold leading-5 text-white">
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </Link>
  );
}

type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
const storage = safeStorage();

/** Android/desktop install prompt + one-time iOS "add to home screen" hint. */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => storage.get('somar.install.dismissed') === '1');
  const [iosDismissed, setIosDismissed] = useState(() => storage.get('somar.ios.hint') === '1');

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  if (isStandalone()) return null;

  if (isIos() && !iosDismissed) {
    return (
      <div className="mb-4 flex items-start gap-3 rounded-xl border border-border bg-surface p-3 text-sm">
        <Share className="mt-0.5 h-5 w-5 shrink-0 text-brand-ink" aria-hidden />
        <div className="flex-1">
          <p className="font-bold">{t.student.iosHintTitle}</p>
          <p className="mt-1 text-muted">{t.student.iosHintBody}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t.common.close}
          onClick={() => {
            storage.set('somar.ios.hint', '1');
            setIosDismissed(true);
          }}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  if (!deferred || dismissed) return null;
  return (
    <div className="mb-4 flex items-center gap-3 rounded-xl border border-border bg-surface p-3 text-sm">
      <Download className="h-5 w-5 shrink-0 text-brand-ink" aria-hidden />
      <div className="flex-1">
        <p className="font-bold">{t.student.installTitle}</p>
        <p className="text-muted">{t.student.installBody}</p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={async () => {
          await deferred.prompt();
          setDeferred(null);
        }}
      >
        {t.student.install}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          storage.set('somar.install.dismissed', '1');
          setDismissed(true);
        }}
      >
        {t.student.later}
      </Button>
    </div>
  );
}

export function UniversityPicker({ className }: { className?: string }) {
  const { universities, universityId, setUniversityId, isAdmin, university } = useScope();
  if (!isAdmin) return university ? <span className={cn('text-sm font-semibold', className)}>{university.name}</span> : null;
  if (!universities.length) return null;
  return (
    <Select
      aria-label={t.university.picker}
      className={cn('max-w-[260px] text-sm', className)}
      value={universityId ?? ''}
      onChange={(e) => setUniversityId(e.target.value)}
    >
      {universities.map((u) => (
        <option key={u.id} value={u.id}>
          {u.name}
        </option>
      ))}
    </Select>
  );
}

export function DirectionBadge({ direction, className }: { direction: string; className?: string }) {
  const outbound = direction === 'outbound';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold',
        outbound ? 'bg-brand-ink text-white' : 'bg-success/15 text-success',
        className,
      )}
    >
      {outbound ? t.student.outbound : t.student.return}
    </span>
  );
}
