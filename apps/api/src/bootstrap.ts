import { isPasswordValid } from '@somar/shared';
import { loadConfig } from './config.js';
import { createAdminClient } from './lib/supabase.js';
import { provisionStaff } from './services/provisioning.js';

/** Creates the first admin from env. Returns a human-readable result line. */
export async function runBootstrapAdmin(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  try {
    const { config } = await import('dotenv');
    config();
  } catch {
    /* dotenv is optional inside the production image; env vars come from the platform */
  }
  const cfg = loadConfig({ ...env, DISABLE_CRON: 'true' });
  const code = (env.BOOTSTRAP_ADMIN_CODE || 'ADMIN').trim();
  const password = env.BOOTSTRAP_ADMIN_PASSWORD ?? '';
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  if (!isPasswordValid(password, null, 8)) {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 8 characters with an uppercase letter, a digit and a symbol');
  }
  const db = createAdminClient(cfg);
  const { data: existing, error } = await db.from('profiles').select('id').ilike('login_code', code).maybeSingle();
  if (error) throw new Error(`database not reachable or migrations missing: ${error.message}`);
  if (existing) return `admin "${code}" already exists — nothing to do`;
  await provisionStaff(db, cfg, {
    login_code: code,
    full_name: 'مدير النظام',
    university_id: null,
    password,
    role: 'admin',
    must_change_password: false,
  });
  return `admin "${code}" created`;
}
