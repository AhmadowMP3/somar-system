import { z } from 'zod';
import { PERMISSION_KEYS } from './permissions.js';

export type ScanDirection = 'outbound' | 'return';
export type ScanMethod = 'qr' | 'manual';

export type ScanSuccess = {
  ok: true;
  /** A preview records nothing (scan_id is null) — the supervisor checks the photo, then confirms. */
  preview?: boolean;
  scan_id: string | null;
  direction: ScanDirection;
  method: ScanMethod;
  scanned_at: string;
  student: {
    id: string;
    full_name: string;
    transport_number: string;
    /** The college, or a doctor's / employee's job title. */
    college: string | null;
    kind?: 'student' | 'doctor' | 'employee';
    photo_path: string | null;
    photo_url: string | null;
  };
  /** Doctors and university employees: no package and no quota (quota/remaining are null). */
  unlimited?: boolean;
  quota: number | null;
  used: number;
  remaining_after: number | null;
  subscription_ends_on: string | null;
  /** Today is not one of the rider's work days: allowed, but shown as a warning. */
  offday_override: boolean;
  warning: 'LOW_BALANCE' | null;
  /** The bus chosen before scanning; boarded = riders on it today in this direction (this one once recorded). */
  bus?: ScanBus | null;
  /** Today's seat booking for this scan's direction; never blocks the scan. */
  booking?: ScanBooking;
};

export type ScanBus = { id: string; bus_number: string; plate_number: string; seats: number; boarded: number };

/** time is HH:MM (null on a booking made before outbound times were asked). */
export type ScanBooking = { booked: true; time: string | null; stop_name: string | null } | { booked: false };

export type ScanFailure = {
  ok: false;
  code: string;
  message_ar: string;
  minutes_remaining?: number;
};

export type ScanResult = ScanSuccess | ScanFailure;

export const scanRequestSchema = z.object({
  qr_token: z.string().uuid().nullish(),
  transport_number: z.string().trim().min(1).max(40).nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  accuracy: z.number().min(0).nullish(),
  geo_denied: z.boolean().optional().default(false),
  override_reason: z.string().trim().max(500).nullish(),
  /** Run every check and return the rider without recording the scan. */
  preview: z.boolean().optional().default(false),
  /** The bus the supervisor is on; required once the rider's university has an active bus. */
  bus_id: z.string().uuid().nullish(),
});
export type ScanRequest = z.infer<typeof scanRequestSchema>;

export const studentInputSchema = z.object({
  university_id: z.string().uuid(),
  college_id: z.string().uuid(),
  full_name: z.string().trim().min(1).max(200),
  university_student_no: z.string().trim().min(1).max(40),
  /** Becomes the initial password; the transport number is used when it is empty. */
  national_id: z.string().trim().max(40).nullish(),
  phone: z.string().trim().min(1).max(40),
  residence_text: z.string().trim().max(300).nullish(),
  area_primary_id: z.string().uuid().nullish(),
  area_secondary_id: z.string().uuid().nullish(),
  area_other_text: z.string().trim().max(300).nullish(),
  work_days: z.array(z.number().int().min(1).max(7)).min(1),
  shift_start: z.enum(['08:00', '10:00', '12:00', '14:00']),
});
export type StudentInput = z.infer<typeof studentInputSchema>;

export const staffInputSchema = z.object({
  login_code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[A-Za-z0-9._-]+$/),
  full_name: z.string().trim().min(2).max(200),
  phone: z.string().trim().max(40).nullish(),
  university_id: z.string().uuid(),
  password: z.string().min(6).max(128),
  role: z.enum(['supervisor', 'university_supervisor']).default('supervisor'),
  /** When given, the role is derived from it (see roleForPermissions). */
  permissions: z.array(z.enum(PERMISSION_KEYS)).min(1).max(PERMISSION_KEYS.length).optional(),
});
export type StaffInput = z.infer<typeof staffInputSchema>;

export const broadcastSchema = z.object({
  university_id: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(1000),
  audience: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('university') }),
    z.object({ kind: z.literal('college'), college_id: z.string().uuid() }),
    z.object({ kind: z.literal('package'), package_id: z.string().uuid() }),
    z.object({ kind: z.literal('student'), student_id: z.string().uuid() }),
    // students picked on the students list
    z.object({ kind: z.literal('students'), student_ids: z.array(z.string().uuid()).min(1).max(10000) }),
  ]),
});
export type BroadcastInput = z.infer<typeof broadcastSchema>;

export type ApiError = { ok: false; code: string; message_ar: string; details?: unknown };
