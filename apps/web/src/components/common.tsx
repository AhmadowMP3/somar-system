import { useQuery } from '@tanstack/react-query';
import { Bell, Download, Share, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { t } from '@/i18n/ar';
import { useAuth, useScope } from '@/app/auth';
import { getInstallPrompt, isIos, isStandalone, promptInstall, subscribeInstall } from '@/lib/pwa';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { Dialog } from './ui/overlay';
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
    <div role="status" className="flex items-center justify-center gap-2 bg-brand-ink px-4 py-2 text-sm text-on-ink">
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

/** Current install possibility: native prompt (Android/desktop Chromium), iOS manual steps, or nothing. */
export function useInstallAvailability(): 'prompt' | 'ios' | null {
  const [, force] = useState(0);
  useEffect(() => subscribeInstall(() => force((n) => n + 1)), []);
  if (isStandalone()) return null;
  if (getInstallPrompt()) return 'prompt';
  if (isIos()) return 'ios';
  return null;
}

export function IosInstallSteps() {
  return (
    <ol className="list-decimal space-y-2 ps-5 text-sm leading-7" data-testid="ios-install-steps">
      <li>
        {t.install.iosStep1} <Share className="inline h-4 w-4 text-brand-ink" aria-hidden />
      </li>
      <li>{t.install.iosStep2}</li>
      <li>{t.install.iosStep3}</li>
    </ol>
  );
}

/** One-tap install: opens the native install dialog, or the iPhone steps where no dialog exists. */
export function InstallButton({ className, full }: { className?: string; full?: boolean }) {
  const mode = useInstallAvailability();
  const [iosOpen, setIosOpen] = useState(false);
  if (!mode) return null;
  return (
    <>
      <Button
        size={full ? 'lg' : 'sm'}
        variant={full ? 'primary' : 'outline'}
        className={cn(full && 'w-full', className)}
        onClick={() => (mode === 'prompt' ? void promptInstall() : setIosOpen(true))}
        data-testid="install-app"
      >
        <Download className="h-4 w-4" aria-hidden />
        {t.install.button}
      </Button>
      <Dialog open={iosOpen} onOpenChange={setIosOpen} title={t.install.iosTitle} description={t.install.iosIntro}>
        <IosInstallSteps />
      </Dialog>
    </>
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
        outbound ? 'bg-brand-ink text-on-ink' : 'bg-success/15 text-success',
        className,
      )}
    >
      {outbound ? t.student.outbound : t.student.return}
    </span>
  );
}
