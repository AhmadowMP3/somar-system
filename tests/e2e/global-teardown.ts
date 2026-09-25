import { destroyE2EUniversities } from './fixtures.js';

export default async function globalTeardown() {
  await destroyE2EUniversities();
}
