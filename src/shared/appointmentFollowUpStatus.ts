import { isAppointmentVisible } from './appointmentVisibility.js';

export interface FollowUpAppointmentEvidence {
  id: number;
  contact_id: number;
  scheduled_at: string;
  status: 'scheduled' | 'confirmed';
  appointment_type: string;
}

export interface AppointmentFollowUpInput {
  id: number | string;
  contact_id: number | null;
  contact?: { id: number } | null;
  scheduled_at: string;
  duration: number;
  status: string;
  appointment_type: string;
  all_day?: boolean;
  follow_up_appointments?: FollowUpAppointmentEvidence[];
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function instant(value: unknown): number {
  // API appointment timestamps are normalized UTC/offset instants. Unzoned
  // strings must not silently become the viewer's wall time.
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    ? Date.parse(value) : NaN;
}

/** A calendar day is interpreted in the viewer's zone, never the lead's zone. */
export function getAppointmentLocalDateKey(date: Date, timeZone: string): string | null {
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value;
    const year = value('year'), month = value('month'), day = value('day');
    return year && month && day ? `${year}-${month}-${day}` : null;
  } catch { return null; }
}

/**
 * This is read-only presentation evidence, separate from dispositions and AI
 * follow-up runs. Missing or inconsistent evidence must not imply outreach is
 * needed. Keep every candidate so a clock tick can expire one without hiding a
 * later booking for the same contact.
 */
export function getAppointmentFollowUpStatus(
  appointment: AppointmentFollowUpInput, now: Date, timeZone: string,
): 'scheduled' | 'needed' | null {
  if (!positiveId(appointment.id) || !positiveId(appointment.contact_id) ||
    appointment.contact?.id !== appointment.contact_id || appointment.all_day ||
    typeof appointment.status !== 'string' || typeof appointment.appointment_type !== 'string' ||
    !isAppointmentVisible(appointment) || !Number.isFinite(appointment.duration) || appointment.duration <= 0 ||
    !['scheduled', 'confirmed', 'completed', 'no_show'].includes(appointment.status) ||
    !Array.isArray(appointment.follow_up_appointments)) return null;

  const startMs = instant(appointment.scheduled_at);
  const start = new Date(startMs);
  const nowMs = now.getTime();
  const endMs = startMs + appointment.duration * 60_000;
  if (![nowMs, startMs, endMs].every(Number.isFinite) || endMs > nowMs) return null;
  const today = getAppointmentLocalDateKey(now, timeZone);
  if (!today || getAppointmentLocalDateKey(start, timeZone) !== today) return null;

  let scheduled = false;
  for (const candidate of appointment.follow_up_appointments) {
    if (!candidate || !positiveId(candidate.id) || candidate.contact_id !== appointment.contact_id ||
      typeof candidate.scheduled_at !== 'string' || typeof candidate.appointment_type !== 'string' ||
      (candidate.status !== 'scheduled' && candidate.status !== 'confirmed')) return null;
    const candidateStart = instant(candidate.scheduled_at);
    if (!Number.isFinite(candidateStart)) return null;
    if (candidate.id !== appointment.id && isAppointmentVisible(candidate) &&
      candidateStart > nowMs && candidateStart >= endMs) scheduled = true;
  }
  return scheduled ? 'scheduled' : 'needed';
}
