export type RuntimeConfig = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  apiBaseUrl: string;
  vapidPublicKey: string;
  emailDomain: string;
  appName: string;
};

declare global {
  interface Window {
    __APP_CONFIG__?: Partial<RuntimeConfig>;
  }
}

const runtime: Partial<RuntimeConfig> = (typeof window !== 'undefined' && window.__APP_CONFIG__) || {};
const env = import.meta.env;

/** Runtime values injected by the server win over build-time VITE_* values. */
export const config: RuntimeConfig = {
  supabaseUrl: runtime.supabaseUrl || env.VITE_SUPABASE_URL || '',
  supabaseAnonKey: runtime.supabaseAnonKey || env.VITE_SUPABASE_ANON_KEY || '',
  apiBaseUrl: runtime.apiBaseUrl || env.VITE_API_BASE_URL || '/api',
  vapidPublicKey: runtime.vapidPublicKey || env.VITE_VAPID_PUBLIC_KEY || '',
  emailDomain: runtime.emailDomain || env.VITE_STUDENT_EMAIL_DOMAIN || 'somar.local',
  appName: runtime.appName || env.VITE_APP_NAME || '',
};

export const isConfigured = Boolean(config.supabaseUrl && config.supabaseAnonKey);
