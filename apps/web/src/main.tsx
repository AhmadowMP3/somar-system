import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { AuthProvider, UniversityScopeProvider } from '@/app/auth';
import { router } from '@/app/router';
import { ToastProvider } from '@/components/ui/overlay';
import { t } from '@/i18n/ar';
import { isConfigured } from '@/lib/config';
import { registerServiceWorker } from '@/lib/pwa';
import '@/styles/index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false },
    mutations: { retry: 0 },
  },
});

function ConfigMissing() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface p-6">
      <div role="alert" className="max-w-md rounded-2xl border border-danger/40 bg-bg p-6 text-center shadow">
        <h1 className="mb-2 text-lg font-extrabold text-danger">{t.config.missingTitle}</h1>
        <p className="text-sm leading-7 text-text">{t.config.missingBody}</p>
      </div>
    </main>
  );
}

document.title = t.appName;
registerServiceWorker();

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    {isConfigured ? (
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <AuthProvider>
            <UniversityScopeProvider>
              <RouterProvider router={router} />
            </UniversityScopeProvider>
          </AuthProvider>
        </ToastProvider>
      </QueryClientProvider>
    ) : (
      <ConfigMissing />
    )}
  </StrictMode>,
);
