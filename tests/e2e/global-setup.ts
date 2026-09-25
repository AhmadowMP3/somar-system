import { ADMIN_CODE, demoUniversityId, destroyE2EUniversities, service } from './fixtures.js';

export default async function globalSetup() {
  await destroyE2EUniversities();
  const { data: admin } = await service.from('profiles').select('id').ilike('login_code', ADMIN_CODE).maybeSingle();
  if (!admin) throw new Error(`Admin "${ADMIN_CODE}" is missing — run "npm run bootstrap:admin" or "npm run seed:demo" first`);
  if (!(await demoUniversityId())) throw new Error('Demo data is missing — run "npm run seed:demo" first');
}
