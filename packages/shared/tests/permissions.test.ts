import { describe, expect, it } from 'vitest';
import { hasPermission, PERMISSION_KEYS, roleForPermissions } from '../src/permissions.js';

describe('page permissions', () => {
  it('the admin always has every page', () => {
    for (const key of PERMISSION_KEYS) expect(hasPermission('admin', [], key)).toBe(true);
  });

  it('no stored permissions keeps the historical access of the role', () => {
    expect(hasPermission('university_supervisor', null, 'audit')).toBe(true);
    expect(hasPermission('supervisor', null, 'scan')).toBe(true);
    expect(hasPermission('supervisor', null, 'routes')).toBe(false);
    expect(hasPermission('student', null, 'scan')).toBe(false);
  });

  it('stored permissions are the exact list of pages', () => {
    expect(hasPermission('university_supervisor', ['routes'], 'routes')).toBe(true);
    expect(hasPermission('university_supervisor', ['routes'], 'scan')).toBe(false);
    expect(hasPermission('supervisor', ['scan'], 'scan')).toBe(true);
  });

  it('the role follows the pages: anything beyond scanning needs the staff panel', () => {
    expect(roleForPermissions(['scan'])).toBe('supervisor');
    expect(roleForPermissions(['scan', 'pickups'])).toBe('university_supervisor');
    expect(roleForPermissions(['audit'])).toBe('university_supervisor');
  });
});
