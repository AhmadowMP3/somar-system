import { BellRing, LogOut, RefreshCw, Smartphone } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@/app/auth';
import { t } from '@/i18n/ar';
import { errorMessage } from '@/lib/errors';
import { currentPushState, enablePush } from '@/lib/push';
import { isIos, isStandalone } from '@/lib/pwa';
import { CreditFooter, InstallButton, IosInstallSteps, Logo } from './common';
import { Button, Card } from './ui/primitives';
import { ListSkeleton } from './ui/states';

type GateState = 'checking' | 'ok' | 'ask' | 'denied' | 'install-ios';

/**
 * Notifications are mandatory for every signed-in user (student, supervisor, staff):
 * the app stays behind this screen until this device has a push subscription.
 * Browsers that cannot do web push at all are let through, since nothing the user
 * does could satisfy the gate; an iPhone outside the installed app is asked to install first.
 */
export function PushGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>('checking');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    const s = await currentPushState();
    if (s === 'enabled') {
      // re-link this device's subscription to whoever is signed in now (shared phones)
      void enablePush().catch(() => undefined);
      setState('ok');
    } else if (s === 'unsupported') setState(isIos() && !isStandalone() ? 'install-ios' : 'ok');
    else setState(s === 'denied' ? 'denied' : 'ask');
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await enablePush();
      if (result === 'enabled') setState('ok');
      else if (result === 'denied') setState('denied');
      else setState('ok');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (state === 'checking')
    return (
      <div className="mx-auto max-w-md p-6">
        <ListSkeleton rows={4} />
      </div>
    );
  if (state === 'ok') return <>{children}</>;
  return (
    <GateShell>
      {state === 'install-ios' ? (
        <>
          <Smartphone className="mx-auto h-12 w-12 text-brand-ink" aria-hidden />
          <h1 className="text-xl font-extrabold">{t.pushGate.iosTitle}</h1>
          <p className="text-sm leading-7 text-muted">{t.pushGate.iosBody}</p>
          <div className="text-start">
            <IosInstallSteps />
          </div>
        </>
      ) : state === 'denied' ? (
        <>
          <BellRing className="mx-auto h-12 w-12 text-danger" aria-hidden />
          <h1 className="text-xl font-extrabold">{t.pushGate.deniedTitle}</h1>
          <p className="text-sm leading-7 text-muted">{t.pushGate.deniedBody}</p>
          <ol className="list-decimal space-y-1 ps-5 text-start text-sm leading-7">
            {t.pushGate.deniedSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <Button size="lg" className="w-full" variant="primary" onClick={() => void check()} data-testid="push-recheck">
            <RefreshCw className="h-5 w-5" aria-hidden />
            {t.pushGate.recheck}
          </Button>
        </>
      ) : (
        <>
          <BellRing className="mx-auto h-12 w-12 text-brand" aria-hidden />
          <h1 className="text-xl font-extrabold">{t.pushGate.title}</h1>
          <p className="text-sm leading-7 text-muted">{t.pushGate.body}</p>
          <Button size="lg" className="w-full" variant="primary" disabled={busy} onClick={() => void enable()} data-testid="push-enable">
            <BellRing className="h-5 w-5" aria-hidden />
            {t.pushGate.enable}
          </Button>
        </>
      )}
      {error ? (
        <p role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
      <InstallButton full />
    </GateShell>
  );
}

function GateShell({ children }: { children: ReactNode }) {
  const { signOut } = useAuth();
  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface px-4 py-8" data-testid="push-gate">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Logo className="h-16" />
        </div>
        <Card className="space-y-4 p-5 text-center">{children}</Card>
        <div className="mt-4 flex justify-center">
          <Button variant="ghost" size="sm" onClick={() => void signOut()}>
            <LogOut className="h-4 w-4" aria-hidden />
            {t.auth.logout}
          </Button>
        </div>
        <CreditFooter />
      </div>
    </main>
  );
}
