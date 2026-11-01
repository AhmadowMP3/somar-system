import { describe, expect, it } from 'vitest';
import { staffRecipientsFilter } from '../../src/services/push.js';

describe('staffRecipientsFilter', () => {
  it('sends a new note or complaint to the admin only, other staff notifications to university supervisors too', () => {
    expect(staffRecipientsFilter({ type: 'FEEDBACK', university_id: 'u1' })).toBe('role.eq.admin');
    expect(staffRecipientsFilter({ type: 'LOW_BALANCE_DIGEST', university_id: 'u1' })).toBe(
      'role.eq.admin,and(role.eq.university_supervisor,university_id.eq.u1)',
    );
  });
});
