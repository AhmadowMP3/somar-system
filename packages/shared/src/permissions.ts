/**
 * Page permissions for supervisors. The admin always has everything.
 * `null` permissions keep the role's historical access: a university supervisor sees every staff page,
 * a supervisor only scans. Keep this list in sync with the database check in migration 0013.
 */
export const PERMISSION_KEYS = [
  'dashboard',
  'students',
  'import',
  'packages',
  'routes',
  'org',
  'stats',
  'pickups',
  'scans',
  'scan',
  'notifications',
  'supervisors',
  'settings',
  'audit',
] as const;

export type Permission = (typeof PERMISSION_KEYS)[number];

/** Anything beyond scanning needs the admin panel, i.e. the university-supervisor role. */
export function roleForPermissions(permissions: readonly Permission[]): 'supervisor' | 'university_supervisor' {
  return permissions.some((p) => p !== 'scan') ? 'university_supervisor' : 'supervisor';
}

export function hasPermission(role: string | null | undefined, permissions: readonly string[] | null | undefined, key: Permission): boolean {
  if (role === 'admin') return true;
  if (role === 'university_supervisor') return permissions == null || permissions.includes(key);
  if (role === 'supervisor') return permissions == null ? key === 'scan' : permissions.includes(key);
  return false;
}
