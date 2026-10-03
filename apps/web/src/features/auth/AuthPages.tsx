import { useMutation, useQuery } from '@tanstack/react-query';
import { Camera, CheckCircle2, Circle, Eye, EyeOff, ImageUp } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { checkPassword } from '@somar/shared';
import { useAuth } from '@/app/auth';
import { AppearanceMenu } from '@/components/AppearanceMenu';
import { CreditFooter, InstallButton, Logo } from '@/components/common';
import { Button, Card, Field, Input } from '@/components/ui/primitives';
import { t } from '@/i18n/ar';
import { api, ApiClientError } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { supabase } from '@/lib/supabase';

/** One-shot message shown on the login screen after a forced sign-out (survives the auth redirect). */
const pendingNotice: { value: string | null } = { value: null };

function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <main className="relative flex min-h-dvh items-center justify-center bg-surface px-4 py-8">
      <AppearanceMenu className="absolute end-3 top-3" />
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Logo className="h-16" />
          <h1 className="text-2xl font-extrabold text-brand-ink">{title}</h1>
          {subtitle ? <p className="text-sm text-muted">{subtitle}</p> : null}
        </div>
        <Card className="p-5">{children}</Card>
        <div className="mt-4">
          <InstallButton full />
        </div>
        <CreditFooter />
      </div>
    </main>
  );
}

function PasswordInput({ id, value, onChange, autoComplete }: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? 'text' : 'password'}
        dir="ltr"
        className="ps-12 text-start"
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        required
      />
      <button
        type="button"
        className="absolute inset-y-0 end-0 flex w-12 items-center justify-center text-muted"
        aria-label={show ? t.auth.hidePassword : t.auth.showPassword}
        onClick={() => setShow((s) => !s)}
      >
        {show ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
      </button>
    </div>
  );
}

export function LoginPage() {
  const { session, signIn } = useAuth();
  const location = useLocation();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice] = useState<string | null>(
    () => pendingNotice.value ?? (location.state as { notice?: string } | null)?.notice ?? null,
  );
  useEffect(() => {
    pendingNotice.value = null;
  }, []);
  const codeId = useId();
  const pwId = useId();

  if (session) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const ok = await signIn(code, password);
    setBusy(false);
    if (!ok) setError(t.auth.invalid);
  };

  return (
    <AuthShell title={t.auth.loginTitle} subtitle={t.auth.loginSubtitle}>
      {notice ? (
        <p role="status" className="mb-4 rounded-lg bg-success/10 p-3 text-sm font-semibold text-success">
          {notice}
        </p>
      ) : null}
      <form className="space-y-4" onSubmit={submit} noValidate>
        <Field label={t.auth.code} htmlFor={codeId}>
          <Input
            id={codeId}
            dir="ltr"
            className="text-start uppercase"
            placeholder={t.auth.codePlaceholder}
            autoComplete="username"
            autoCapitalize="characters"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
        </Field>
        <Field label={t.auth.password} htmlFor={pwId}>
          <PasswordInput id={pwId} value={password} onChange={setPassword} autoComplete="current-password" />
        </Field>
        {error ? (
          <p role="alert" className="text-sm font-semibold text-danger">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy || !code || !password}>
          {busy ? t.auth.loggingIn : t.auth.login}
        </Button>
        <p className="text-center text-xs text-muted">{t.auth.noSelfService}</p>
      </form>
    </AuthShell>
  );
}

export function ChangePasswordPage() {
  const { me, signOut } = useAuth();
  const navigate = useNavigate();
  const forced = Boolean(me?.profile?.must_change_password);
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const ids = { current: useId(), password: useId(), confirm: useId() };

  const settings = useQuery({
    queryKey: ['settings', 'self'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_settings');
      if (error) throw error;
      return data as { password_min_length: number };
    },
  });
  const minLength = settings.data?.password_min_length ?? 8;
  const rules = checkPassword(password, confirm, minLength);
  const valid = rules.every((r) => r.ok) && (forced || current.length > 0);

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/me/password', { password, confirm, current_password: forced ? undefined : current }),
    onSuccess: async () => {
      pendingNotice.value = t.auth.changed;
      await signOut();
      navigate('/login', { replace: true });
    },
  });

  const errorText =
    mutation.error instanceof ApiClientError && mutation.error.code === 'CURRENT_PASSWORD'
      ? t.auth.currentWrong
      : mutation.error
        ? errorMessage(mutation.error)
        : null;

  return (
    <AuthShell title={t.auth.changeTitle} subtitle={forced ? t.auth.forcedChangeBody : undefined}>
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) mutation.mutate();
        }}
      >
        {!forced ? (
          <Field label={t.auth.currentPassword} htmlFor={ids.current}>
            <PasswordInput id={ids.current} value={current} onChange={setCurrent} autoComplete="current-password" />
          </Field>
        ) : null}
        <Field label={t.auth.newPassword} htmlFor={ids.password}>
          <PasswordInput id={ids.password} value={password} onChange={setPassword} autoComplete="new-password" />
        </Field>
        <Field label={t.auth.confirmPassword} htmlFor={ids.confirm}>
          <PasswordInput id={ids.confirm} value={confirm} onChange={setConfirm} autoComplete="new-password" />
        </Field>
        <div>
          <p className="mb-2 text-sm font-bold">{t.auth.rulesTitle}</p>
          <ul className="space-y-1.5 text-sm" aria-live="polite">
            {rules.map((r) => (
              <li key={r.key} className={r.ok ? 'flex items-center gap-2 text-success' : 'flex items-center gap-2 text-muted'}>
                {r.ok ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <Circle className="h-4 w-4" aria-hidden />}
                {r.label}
              </li>
            ))}
          </ul>
        </div>
        {errorText ? (
          <p role="alert" className="text-sm font-semibold text-danger">
            {errorText}
          </p>
        ) : null}
        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={!valid || mutation.isPending}>
          {mutation.isPending ? t.common.saving : t.auth.change}
        </Button>
        {!forced ? (
          <Button className="w-full" onClick={() => navigate(-1)}>
            {t.common.back}
          </Button>
        ) : (
          <Button variant="ghost" className="w-full" onClick={() => void signOut()}>
            {t.auth.logout}
          </Button>
        )}
      </form>
    </AuthShell>
  );
}

export function PhotoUploadPage() {
  const { me, refreshMe, signOut } = useAuth();
  const navigate = useNavigate();
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const mutation = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append('photo', file as File);
      return api.post('/me/photo', form);
    },
    onSuccess: async () => {
      await refreshMe();
      navigate('/', { replace: true });
    },
  });

  if (me?.student?.photo_path) return <Navigate to="/" replace />;

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setFile(f);
    e.target.value = '';
  };

  return (
    <AuthShell title={t.photo.title} subtitle={t.photo.body}>
      <div className="space-y-4">
        <div className="mx-auto flex h-48 w-48 items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-border bg-surface">
          {preview ? (
            <img src={preview} alt={t.photo.preview} className="h-full w-full object-cover" />
          ) : (
            <Camera className="h-14 w-14 text-brand-silver" aria-hidden />
          )}
        </div>
        <input ref={cameraRef} type="file" accept="image/jpeg,image/png,image/webp" capture="user" className="hidden" onChange={onPick} data-testid="photo-camera-input" />
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={onPick} data-testid="photo-file-input" />
        {!file ? (
          <>
            <Button variant="secondary" size="lg" className="w-full" onClick={() => cameraRef.current?.click()}>
              <Camera className="h-5 w-5" aria-hidden />
              {t.photo.takePhoto}
            </Button>
            <Button size="lg" className="w-full" onClick={() => fileRef.current?.click()}>
              <ImageUp className="h-5 w-5" aria-hidden />
              {t.photo.chooseFile}
            </Button>
            <p className="text-center text-xs text-muted">{t.photo.hint}</p>
          </>
        ) : (
          <>
            <Button variant="primary" size="lg" className="w-full" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              {mutation.isPending ? t.photo.uploading : t.photo.confirmUpload}
            </Button>
            <Button className="w-full" disabled={mutation.isPending} onClick={() => setFile(null)}>
              {t.photo.change}
            </Button>
          </>
        )}
        {mutation.error ? (
          <p role="alert" className="text-sm font-semibold text-danger">
            {errorMessage(mutation.error)}
          </p>
        ) : null}
        <Button variant="ghost" className="w-full" onClick={() => void signOut()}>
          {t.auth.logout}
        </Button>
      </div>
    </AuthShell>
  );
}
