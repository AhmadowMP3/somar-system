import { BrowserQRCodeReader, type IScannerControls } from '@zxing/browser';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Flashlight, Keyboard, MapPin, MapPinOff, RefreshCw, SwitchCamera, UserRound, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { formatDate, formatTime, parseQrPayload, type ScanRequest, type ScanResult } from '@somar/shared';
import { DirectionBadge, useOnline } from '@/components/common';
import { Badge, Button, Card, CardTitle, Field, Input, Textarea } from '@/components/ui/primitives';
import { EmptyState, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { feedback, unlockAudio } from '@/lib/feedback';
import { supabase, unwrap } from '@/lib/supabase';
import { cn } from '@/lib/utils';

type GeoState =
  | { status: 'requesting' }
  | { status: 'ok'; lat: number; lng: number; accuracy: number }
  | { status: 'denied' }
  | { status: 'unavailable' };

function useGeolocation() {
  const [geo, setGeo] = useState<GeoState>({ status: 'requesting' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setGeo({ status: 'unavailable' });
      return;
    }
    setGeo({ status: 'requesting' });
    const id = navigator.geolocation.watchPosition(
      (pos) => setGeo({ status: 'ok', lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => setGeo({ status: err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [attempt]);
  return { geo, retry: () => setAttempt((a) => a + 1) };
}

type Pending = { payload: Omit<ScanRequest, 'lat' | 'lng' | 'accuracy' | 'geo_denied'> };

export default function ScanPage() {
  const online = useOnline();
  const { geo, retry: retryGeo } = useGeolocation();
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ['settings', 'self'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_settings');
      if (error) throw error;
      return data as { require_supervisor_geo: boolean };
    },
  });
  const requireGeo = settings.data?.require_supervisor_geo ?? true;
  const geoBlocked = requireGeo && geo.status !== 'ok';
  const disabled = !online || geoBlocked;

  const [cameraOn, setCameraOn] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [manual, setManual] = useState('');
  const manualId = useId();
  const overrideId = useId();

  const scan = useMutation({
    mutationFn: async (p: Pending & { override_reason?: string }) => {
      const body: ScanRequest = {
        ...p.payload,
        override_reason: p.override_reason ?? null,
        lat: geo.status === 'ok' ? geo.lat : null,
        lng: geo.status === 'ok' ? geo.lng : null,
        accuracy: geo.status === 'ok' ? geo.accuracy : null,
        geo_denied: geo.status === 'denied',
      };
      return api.post<ScanResult>('/scan', body);
    },
    onSuccess: (res, vars) => {
      setPending(res.ok ? null : { payload: vars.payload });
      setResult(res);
      feedback(res.ok ? 'success' : 'error');
      if (res.ok) void qc.invalidateQueries({ queryKey: ['my-scans-today'] });
    },
    onError: (err) => {
      setResult({ ok: false, code: 'NETWORK', message_ar: errorMessage(err) });
      feedback('error');
    },
  });

  const submit = useCallback(
    (payload: Pending['payload']) => {
      if (disabled || scan.isPending) return;
      setOverrideReason('');
      scan.mutate({ payload });
    },
    [disabled, scan],
  );

  const onDecode = useCallback(
    (text: string) => {
      const token = parseQrPayload(text);
      if (!token) {
        setResult({ ok: false, code: 'UNKNOWN_QR', message_ar: t.scan.invalidQr });
        feedback('error');
        return;
      }
      submit({ qr_token: token });
    },
    [submit],
  );

  const closeResult = () => {
    setResult(null);
    setPending(null);
  };

  const onManual = (e: FormEvent) => {
    e.preventDefault();
    unlockAudio();
    const code = manual.trim();
    if (!code) return;
    submit({ transport_number: code });
    setManual('');
  };

  return (
    <div className="space-y-4">
      {!online ? (
        <p role="alert" className="rounded-xl bg-danger/10 p-4 text-center font-bold text-danger">
          {t.offline.scan}
        </p>
      ) : null}

      <GeoStatus geo={geo} requireGeo={requireGeo} onRetry={retryGeo} />

      <Button
        variant="primary"
        size="lg"
        className="h-28 w-full text-xl"
        disabled={disabled}
        onClick={() => {
          unlockAudio();
          setCameraOn(true);
        }}
      >
        <Camera className="h-8 w-8" aria-hidden />
        {t.scan.start}
      </Button>

      <Card>
        <CardTitle className="flex items-center gap-2">
          <Keyboard className="h-5 w-5" aria-hidden />
          {t.scan.manual}
        </CardTitle>
        <form className="flex gap-2" onSubmit={onManual}>
          <label htmlFor={manualId} className="sr-only">
            {t.scan.manual}
          </label>
          <Input
            id={manualId}
            dir="ltr"
            className="flex-1 text-start uppercase"
            placeholder={t.scan.manualPlaceholder}
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            disabled={disabled}
            autoCapitalize="characters"
            data-testid="manual-input"
          />
          <Button type="submit" variant="secondary" disabled={disabled || !manual.trim() || scan.isPending} data-testid="manual-submit">
            {t.scan.manualSubmit}
          </Button>
        </form>
      </Card>

      <MyScansToday />

      {cameraOn ? (
        <CameraView paused={Boolean(result) || scan.isPending} onDecode={onDecode} onClose={() => setCameraOn(false)} />
      ) : null}

      {result || scan.isPending ? (
        <ResultPopup
          result={result}
          busy={scan.isPending}
          onClose={closeResult}
          override={
            result && !result.ok && result.code === 'OVERRIDE_REASON_REQUIRED' && pending ? (
              <form
                className="mt-4 space-y-2 text-start"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (overrideReason.trim()) scan.mutate({ payload: pending.payload, override_reason: overrideReason.trim() });
                }}
              >
                <p className="text-sm">{t.scan.overrideBody}</p>
                <Field label={t.scan.overrideReason} htmlFor={overrideId}>
                  <Textarea id={overrideId} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
                </Field>
                <Button type="submit" variant="secondary" className="w-full" disabled={!overrideReason.trim()}>
                  {t.scan.overrideSubmit}
                </Button>
              </form>
            ) : null
          }
        />
      ) : null}
    </div>
  );
}

function GeoStatus({ geo, requireGeo, onRetry }: { geo: GeoState; requireGeo: boolean; onRetry: () => void }) {
  if (geo.status === 'ok') {
    return (
      <p className="flex items-center gap-2 text-sm text-success">
        <MapPin className="h-4 w-4" aria-hidden />
        {t.scan.geoOk}
      </p>
    );
  }
  if (geo.status === 'requesting') {
    return (
      <p className="flex items-center gap-2 text-sm text-muted" role="status">
        <MapPin className="h-4 w-4 animate-pulse" aria-hidden />
        {t.scan.geoRequesting}
      </p>
    );
  }
  return (
    <div role={requireGeo ? 'alert' : 'status'} className={cn('rounded-xl p-4 text-sm', requireGeo ? 'bg-danger/10' : 'bg-surface')}>
      <p className={cn('flex items-center gap-2 font-bold', requireGeo ? 'text-danger' : 'text-muted')}>
        <MapPinOff className="h-5 w-5" aria-hidden />
        {geo.status === 'denied' ? t.scan.geoDenied : t.scan.geoUnavailable}
      </p>
      {requireGeo ? <p className="mt-1">{t.shared.scanCodes.GEO_REQUIRED}</p> : null}
      <p className="mt-2 leading-6 text-muted">{t.scan.geoHowTo}</p>
      <Button size="sm" className="mt-3" onClick={onRetry}>
        <RefreshCw className="h-4 w-4" aria-hidden />
        {t.scan.retryGeo}
      </Button>
    </div>
  );
}

function CameraView({ paused, onDecode, onClose }: { paused: boolean; onDecode: (text: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const pausedRef = useRef(paused);
  const lastRef = useRef<{ text: string; at: number } | null>(null);
  const onDecodeRef = useRef(onDecode);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceIndex, setDeviceIndex] = useState<number | null>(null);
  const [torch, setTorch] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  pausedRef.current = paused;
  onDecodeRef.current = onDecode;

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(t.scan.cameraUnsupported);
      return;
    }
    const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 150 });
    let cancelled = false;
    const device = deviceIndex === null ? undefined : devices[deviceIndex];
    const constraints: MediaStreamConstraints = {
      audio: false,
      video: device ? { deviceId: { exact: device.deviceId } } : { facingMode: { ideal: 'environment' } },
    };
    reader
      .decodeFromConstraints(constraints, videoRef.current ?? undefined, (res) => {
        if (!res || pausedRef.current) return;
        const text = res.getText();
        const now = Date.now();
        if (lastRef.current && lastRef.current.text === text && now - lastRef.current.at < 3000) return;
        lastRef.current = { text, at: now };
        onDecodeRef.current(text);
      })
      .then(async (controls) => {
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
        setTorchSupported(Boolean(controls.switchTorch));
        if (!devices.length) {
          const list = await BrowserQRCodeReader.listVideoInputDevices().catch(() => []);
          if (!cancelled) setDevices(list);
        }
      })
      .catch(() => setError(t.scan.cameraError));
    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [deviceIndex, devices]);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black" role="dialog" aria-modal="true" aria-label={t.scan.title}>
      <div className="flex items-center justify-between p-3 text-white">
        <Button variant="ghost" size="icon" className="text-white hover:bg-white/10" aria-label={t.scan.stop} onClick={onClose}>
          <X className="h-7 w-7" />
        </Button>
        <div className="flex gap-2">
          {torchSupported ? (
            <Button
              variant="ghost"
              size="icon"
              className={cn('text-white hover:bg-white/10', torch && 'bg-white/20')}
              aria-label={t.scan.torch}
              aria-pressed={torch}
              onClick={async () => {
                await controlsRef.current?.switchTorch?.(!torch);
                setTorch(!torch);
              }}
            >
              <Flashlight className="h-6 w-6" />
            </Button>
          ) : null}
          {devices.length > 1 ? (
            <Button
              variant="ghost"
              size="icon"
              className="text-white hover:bg-white/10"
              aria-label={t.scan.switchCamera}
              onClick={() => setDeviceIndex((i) => ((i ?? 0) + 1) % devices.length)}
            >
              <SwitchCamera className="h-6 w-6" />
            </Button>
          ) : null}
        </div>
      </div>
      <div className="relative flex-1 overflow-hidden">
        <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-64 w-64 rounded-3xl border-4 border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />
        </div>
      </div>
      <p className="p-4 text-center text-sm text-white">{error ?? t.scan.aimHint}</p>
    </div>
  );
}

function ResultPopup({
  result,
  busy,
  onClose,
  override,
}: {
  result: ScanResult | null;
  busy: boolean;
  onClose: () => void;
  override?: React.ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, [result]);
  const ok = result?.ok === true;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center" role="dialog" aria-modal="true">
      <div
        className={cn(
          'relative w-full max-w-md rounded-2xl bg-bg p-5 text-center shadow-2xl',
          result && !ok && 'border-4 border-danger',
          ok && 'border-4 border-success',
        )}
        aria-live="assertive"
        data-testid="scan-result"
      >
        <Button
          ref={closeRef}
          variant="outline"
          size="icon"
          className="absolute end-3 top-3 h-12 w-12 rounded-full"
          aria-label={t.scan.closeAndNext}
          onClick={onClose}
          disabled={busy}
          data-testid="scan-close"
        >
          <X className="h-7 w-7" />
        </Button>
        {busy || !result ? (
          <p className="py-10 text-lg font-bold" role="status">
            {t.scan.processing}
          </p>
        ) : result.ok ? (
          <div className="space-y-3 pt-6">
            {result.student.photo_url ? (
              <img
                src={result.student.photo_url}
                alt={result.student.full_name}
                className="mx-auto h-56 w-56 rounded-2xl object-cover"
                data-testid="scan-photo"
              />
            ) : (
              <div className="mx-auto flex h-56 w-56 flex-col items-center justify-center rounded-2xl bg-surface text-muted" data-testid="scan-photo">
                <UserRound className="h-16 w-16" aria-hidden />
                {t.scan.noPhoto}
              </div>
            )}
            <p className="text-2xl font-extrabold" data-testid="scan-name">
              {result.student.full_name}
            </p>
            <p className="num font-mono text-sm text-muted">
              {result.student.transport_number} · {result.student.college}
            </p>
            <div className="flex items-center justify-center gap-3">
              <span data-testid="scan-direction">
                <DirectionBadge direction={result.direction} className="px-4 py-1.5 text-lg" />
              </span>
              {result.offday_override ? <Badge tone="warning">{t.student.override}</Badge> : null}
            </div>
            <p className="text-lg">
              {t.scan.remainingAfter}:{' '}
              <span className="num text-3xl font-extrabold text-brand-ink" data-testid="scan-remaining">
                {result.remaining_after}
              </span>
              <span className="text-muted">
                {' '}
                / <span className="num">{result.quota}</span>
              </span>
            </p>
            {result.warning === 'LOW_BALANCE' ? <Badge tone="warning">{t.scan.lowBalance}</Badge> : null}
            <p className="text-xs text-muted">
              {t.scan.subscriptionEnds}: <span className="num">{formatDate(result.subscription_ends_on)}</span>
            </p>
          </div>
        ) : (
          <div className="space-y-2 py-6">
            <p className="text-sm font-bold text-danger">{t.scan.rejected}</p>
            <p className="text-2xl font-extrabold text-danger" data-testid="scan-error">
              {result.message_ar || t.shared.scanCodes[result.code] || t.errors.generic}
            </p>
            {override}
          </div>
        )}
      </div>
    </div>
  );
}

type MyScan = {
  id: string;
  scanned_at: string;
  direction: string;
  method: string;
  offday_override: boolean;
  cancelled_at: string | null;
  student_name: string;
  transport_number: string;
  remaining_after: number;
};

function MyScansToday() {
  const query = useQuery({
    queryKey: ['my-scans-today'],
    queryFn: async () => unwrap(await supabase.rpc('my_scans_today')) as MyScan[],
  });
  return (
    <Card>
      <CardTitle>{t.scan.myScans}</CardTitle>
      <QueryState query={query} empty={(rows) => (rows.length ? null : <EmptyState title={t.scan.noScansToday} />)}>
        {(rows) => (
          <ul className="divide-y divide-border" data-testid="my-scans">
            {rows.map((s) => (
              <li key={s.id} className={cn('flex items-center justify-between gap-2 py-2 text-sm', s.cancelled_at && 'opacity-50')}>
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{s.student_name}</span>
                  <span className="num font-mono text-xs text-muted">{s.transport_number}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <DirectionBadge direction={s.direction} />
                  {s.cancelled_at ? <Badge tone="danger">{t.admin.scans.cancelled}</Badge> : null}
                  <span className="num text-muted">{formatTime(s.scanned_at)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </Card>
  );
}
