/**
 * Creates the first admin account (auth user + profile) from BOOTSTRAP_ADMIN_CODE / BOOTSTRAP_ADMIN_PASSWORD.
 * Safe to re-run: an existing account with that login code is left untouched.
 * Usage: npm run bootstrap:admin   (or inside the container: node apps/api/dist/bootstrap-admin.js)
 */
import { runBootstrapAdmin } from '../apps/api/src/bootstrap.js';

runBootstrapAdmin().then(
  (message) => {
    console.log(message);
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
