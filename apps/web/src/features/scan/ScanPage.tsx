import { BrowserQRCodeReader, type IScannerControls } from '@zxing/browser';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bus, CalendarCheck, Camera, Check, Flashlight, Keyboard, MapPin, MapPinOff, RefreshCw, SwitchCamera, UserRound, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  damascusDate,
  formatClock,
  formatDate,
  formatTime,
  parseQrPayload,
  type ScanBooking,
  type ScanDirection,
  type ScanRequest,
  type ScanResult,
} from '@somar/shared';
import { useAuth, useScope } from '@/app/auth';
import { DirectionBadge, UniversityPicker, useOnline } from '@/components/common';
import { Badge, Button, Card, CardTitle, Input, Select } from '@/components/ui/primitives';
import { EmptyState, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { feedback, unlockAudio } from '@/lib/feedback';
import { safeStorage } from '@/lib/pwa';
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

type Pending = { payload: Omit<ScanRequest, 'lat' | 'lng' | 'accuracy' | 'geo_denied' | 'preview'> };

type BusOption = { id: string; bus_number: string; plate_number: string; seats: number };

const busStorage = safeStorage();

/** The bus this supervisor is on: active buses of the university, the pick kept for the current Damascus day. */
function useScanBus() {
  const { session } = useAuth();
  const { universityId } = useScope();
  const storageKey = `somar.scan.bus.${session?.user.id ?? ''}`;
  const today = damascusDate();
  const buses = useQuery({
    queryKey: ['scan-buses', universityId],
    enabled: Boolean(universityId),
    queryFn: async () =>
      unwrap(
        await supabase
          .from('buses')
          .select('id, bus_number, plate_number, seats')
          .eq('university_id', universityId ?? '')
          .eq('is_active', true)
          .order('bus_number'),
      ) as BusOption[],
  });
  const [pick, setPick] = useState<{ date: string; busId: string | null }>(() => {
    try {
      const saved = JSON.parse(busStorage.get(storageKey) ?? 'null') as { date?: string; busId?: string | null } | null;
      return { date: saved?.date ?? today, busId: saved?.busId ?? null };
    } catch {
      return { date: today, busId: null };
    }
  });
  // the page is often left open overnight; re-render each minute so yesterday's pick drops out
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const list = buses.data ?? [];
  // a bus deactivated or deleted since it was picked has to be picked again
  const bus = pick.date === today ? (list.find((b) => b.id === pick.busId) ?? null) : null;
  const choose = (busId: string | null) => {
    const date = damascusDate();
    setPick({ date, busId });
    busStorage.set(storageKey, JSON.stringify({ date, busId }));
  };
  // until the list loads (or after it fails) we cannot tell whether a bus is required
  const loading = Boolean(universityId) && buses.isPending;
  return {
    buses: list,
    bus,
    choose,
    query: buses,
    blocked: loading || buses.isError || (list.length > 0 && !bus),
    /** Checked right before a scan: false when the day changed since the last render. */
    isCurrent: () => pick.date === damascusDate(),
  };
}

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
  const { buses, bus, choose: chooseBus, query: busQuery, blocked: busBlocked, isCurrent: busIsCurrent } = useScanBus();
  const { isAdmin, universities } = useScope();
  const disabled = !online || geoBlocked || busBlocked;

  const [cameraOn, setCameraOn] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [manual, setManual] = useState('');
  const manualId = useId();

  // Two steps: a preview shows the rider's photo, and only the supervisor's confirmation records the scan.
  const scan = useMutation({
    mutationFn: async (p: Pending & { preview: boolean }) => {
      const body: ScanRequest = {
        ...p.payload,
        preview: p.preview,
        lat: geo.status === 'ok' ? geo.lat : null,
        lng: geo.status === 'ok' ? geo.lng : null,
        accuracy: geo.status === 'ok' ? geo.accuracy : null,
        geo_denied: geo.status === 'denied',
      };
      return api.post<ScanResult>('/scan', body);
    },
    onSuccess: (res, vars) => {
      const awaitingConfirm = res.ok && res.preview === true;
      setPending(awaitingConfirm ? { payload: vars.payload } : null);
      setResult(res);
      if (!awaitingConfirm) feedback(res.ok ? 'success' : 'error');
      if (res.ok && !res.preview) void qc.invalidateQueries({ queryKey: ['my-scans-today'] });
      // the bus list was stale (a bus deactivated or added since it loaded): reload it and ask again
      if (!res.ok && (res.code === 'BUS_INVALID' || res.code === 'BUS_REQUIRED')) {
        chooseBus(null);
        void qc.invalidateQueries({ queryKey: ['scan-buses'] });
      }
    },
    onError: (err) => {
      setResult({ ok: false, code: 'NETWORK', message_ar: errorMessage(err) });
      feedback('error');
    },
  });

  const submit = useCallback(
    (payload: Pending['payload']) => {
      if (disabled || scan.isPending) return;
      if (bus && !busIsCurrent()) {
        chooseBus(null);
        return;
      }
      // the confirm call reuses this payload, so preview and confirm name the same bus
      scan.mutate({ payload: { ...payload, bus_id: bus?.id ?? null }, preview: true });
    },
    [disabled, scan, bus, busIsCurrent, chooseBus],
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

      {isAdmin && universities.length > 1 ? (
        <Card className="space-y-2" data-testid="scan-university">
          <p className="font-bold">{t.scan.scanUniversity}</p>
          <UniversityPicker className="w-full max-w-none" />
          <p className="text-sm text-muted">{t.scan.scanUniversityHint}</p>
        </Card>
      ) : null}

      {busQuery.isError ? (
        <Card className="space-y-2 border-2 border-danger" role="alert" data-testid="scan-bus-error">
          <p className="font-bold text-danger">{t.scan.busesError}</p>
          <Button size="sm" onClick={() => void busQuery.refetch()}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            {t.common.retry}
          </Button>
        </Card>
      ) : busQuery.isLoading ? (
        <p role="status" className="text-sm text-muted">
          {t.scan.busesLoading}
        </p>
      ) : buses.length ? (
        <BusPicker buses={buses} bus={bus} onChoose={chooseBus} />
      ) : null}

      <Button
        variant="primary"
        size="lg"
        className="h-28 w-full text-xl"
        disabled={disabled}
        onClick={() => {
          unlockAudio();
          setCameraOn(true);
        }}
        data-testid="scan-start"
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
          confirm={
            result?.ok && result.preview && pending ? (
              <div className="grid grid-cols-2 gap-2 pt-2">
                <Button variant="outline" size="lg" onClick={closeResult} data-testid="scan-reject">
                  <X className="h-5 w-5" aria-hidden />
                  {t.scan.rejectBoarding}
                </Button>
                <Button
                  variant="primary"
                  size="lg"
                  onClick={() => scan.mutate({ payload: pending.payload, preview: false })}
                  data-testid="scan-confirm"
                >
                  <Check className="h-5 w-5" aria-hidden />
                  {t.scan.confirmBoarding}
                </Button>
              </div>
            ) : null
          }
        />
      ) : null}
    </div>
  );
}

function BusPicker({ buses, bus, onChoose }: { buses: BusOption[]; bus: BusOption | null; onChoose: (id: string | null) => void }) {
  const selectId = useId();
  if (bus) {
    return (
      <Card className="flex items-center justify-between gap-3 border-2 border-brand-ink" data-testid="scan-bus">
        <span className="flex min-w-0 items-center gap-3">
          <Bus className="h-8 w-8 shrink-0 text-brand-ink" aria-hidden />
          <span className="min-w-0">
            <span className="block text-xs text-muted">{t.scan.bus}</span>
            <span className="num block truncate text-2xl font-extrabold">{bus.bus_number}</span>
            <span className="num block truncate font-mono text-sm text-muted">{bus.plate_number}</span>
          </span>
        </span>
        <Button onClick={() => onChoose(null)} data-testid="scan-bus-change">
          {t.scan.changeBus}
        </Button>
      </Card>
    );
  }
  return (
    <Card className="space-y-2 border-2 border-warning" data-testid="scan-bus-picker">
      <label htmlFor={selectId} className="flex items-center gap-2 font-bold">
        <Bus className="h-5 w-5" aria-hidden />
        {t.scan.pickBus}
      </label>
      <Select id={selectId} value="" onChange={(e) => e.target.value && onChoose(e.target.value)} data-testid="scan-bus-select">
        <option value="">{t.scan.pickBus}</option>
        {buses.map((b) => (
          <option key={b.id} value={b.id}>
            {b.bus_number} · {b.plate_number}
          </option>
        ))}
      </Select>
      <p className="text-sm text-muted">{t.scan.pickBusHint}</p>
      <p role="status" className="text-sm font-bold text-warning">
        {t.scan.busRequired}
      </p>
    </Card>
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
    <div className="fixed inset-0 z-[60] flex flex-col bg-black" role="dialog" aria-modal="true" aria-label={t.scan.title}>
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

/** What the rider booked for today in this direction; a missing booking is a warning, not a rejection. */
function BookingLine({ booking, direction }: { booking: ScanBooking; direction: ScanDirection }) {
  if (!booking.booked) {
    return (
      <p role="alert" className="flex items-center justify-center gap-2 rounded-xl bg-warning/15 p-3 text-lg font-extrabold text-warning" data-testid="scan-booking">
        <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden />
        {t.scan.notBooked}
      </p>
    );
  }
  return (
    <p className="flex items-center justify-center gap-2 rounded-xl bg-surface p-3 font-bold" data-testid="scan-booking">
      <CalendarCheck className="h-5 w-5 shrink-0 text-brand-ink" aria-hidden />
      <span className="num">
        {t.scan.bookingLine(
          direction === 'outbound' ? t.student.outbound : t.student.return,
          formatClock(booking.time) || t.pickup.unknown,
          booking.stop_name ?? t.pickup.unknown,
        )}
      </span>
    </p>
  );
}

function ResultPopup({
  result,
  busy,
  onClose,
  confirm,
}: {
  result: ScanResult | null;
  busy: boolean;
  onClose: () => void;
  confirm?: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, [result]);
  const ok = result?.ok === true;
  const preview = result?.ok === true && result.preview === true;
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 p-3 sm:items-center" role="dialog" aria-modal="true">
      <div
        className={cn(
          'relative w-full max-w-md rounded-2xl bg-bg p-5 text-center shadow-2xl',
          result && !ok && 'border-4 border-danger',
          ok && !preview && 'border-4 border-success',
          preview && 'border-4 border-brand-ink',
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
            {preview ? (
              <div>
                <p className="text-lg font-extrabold">{t.scan.verifyTitle}</p>
                <p className="text-sm text-muted">{t.scan.verifyHint}</p>
              </div>
            ) : (
              <p className="text-sm font-bold text-success">{t.scan.success}</p>
            )}
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
            <p className="text-sm text-muted">
              <span className="num font-mono">{result.student.transport_number}</span>
              {result.student.college ? ` · ${result.student.college}` : ''}
              {result.student.kind && result.student.kind !== 'student' ? ` · ${t.student.kind[result.student.kind]}` : ''}
            </p>
            <div className="flex items-center justify-center gap-3">
              <span data-testid="scan-direction">
                <DirectionBadge direction={result.direction} className="px-4 py-1.5 text-lg" />
              </span>
            </div>
            {result.booking ? <BookingLine booking={result.booking} direction={result.direction} /> : null}
            {result.bus ? (
              <p className="flex items-center justify-center gap-2 text-sm" data-testid="scan-result-bus">
                <Bus className="h-4 w-4 shrink-0" aria-hidden />
                <span>
                  {t.scan.bus} <span className="num font-bold">{result.bus.bus_number}</span>
                  {' · '}
                  <span className={cn('num', result.bus.boarded > result.bus.seats && 'font-bold text-danger')}>
                    {t.scan.busOnboard(result.bus.boarded, result.bus.seats)}
                  </span>
                </span>
              </p>
            ) : null}
            {result.offday_override ? (
              <p role="alert" className="flex items-center justify-center gap-2 rounded-xl bg-warning/15 p-3 font-bold text-warning" data-testid="scan-offday">
                <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden />
                {t.scan.offdayWarning}
              </p>
            ) : null}
            {result.unlimited ? (
              <p className="text-lg font-extrabold text-success" data-testid="scan-remaining">
                {t.scan.unlimited}
              </p>
            ) : (
              <>
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
                {result.subscription_ends_on ? (
                  <p className="text-xs text-muted">
                    {t.scan.subscriptionEnds}: <span className="num">{formatDate(result.subscription_ends_on)}</span>
                  </p>
                ) : null}
              </>
            )}
            {confirm}
          </div>
        ) : (
          <div className="space-y-2 py-6">
            <p className="text-sm font-bold text-danger">{t.scan.rejected}</p>
            <p className="text-2xl font-extrabold text-danger" data-testid="scan-error">
              {result.message_ar || t.shared.scanCodes[result.code] || t.errors.generic}
            </p>
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
