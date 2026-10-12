import { authenticatedFetch, getStoredUser } from './dialerApiService';
import { isAppointmentVisible } from '../../shared/appointmentVisibility';
import { getAppointmentFollowUpStatus, type FollowUpAppointmentEvidence } from '../../shared/appointmentFollowUpStatus';

export interface WorkspaceAppointment {
  id: number | string;
  contact_id: number | null;
  appointment_type: string;
  scheduled_at: string;
  duration: number;
  status: string;
  all_day?: boolean;
  attendee_name?: string | null;
  follow_up_appointments?: FollowUpAppointmentEvidence[];
  contact?: {
    id: number;
    firstName?: string | null;
    lastName?: string | null;
    name?: string | null;
    last_call_disposition?: string | null;
    client_status?: 'client' | 'former_client' | null;
  } | null;
}
export interface AppointmentDisposition { id: number; name: string; color?: string }
export interface AppointmentDispositionResult {
  disposition: string | null;
  noShow?: { notice?: string };
  clientStatus?: 'client' | 'former_client' | null;
}
export interface AppointmentSelection { id: number | string; contactId: number }
const base = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(`${base}${path}`, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? body?.message ?? `Unable to load appointments (${response.status}).`);
  if (!body) throw new Error('Crokodial returned an unreadable appointment response. Please refresh.');
  return body.data ?? body;
}

export function linkedAppointmentContact(appointment: WorkspaceAppointment): number | null {
  return Number.isSafeInteger(appointment.contact_id) && Number(appointment.contact_id) > 0 &&
    appointment.contact?.id === appointment.contact_id ? appointment.contact_id : null;
}
export function appointmentName(appointment: WorkspaceAppointment): string {
  const contact = appointment.contact;
  return contact?.name?.trim() || [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim() ||
    appointment.attendee_name?.trim() || appointment.appointment_type || 'Appointment';
}
export function appointmentKey(appointment: Pick<WorkspaceAppointment, 'id'>): string { return `${typeof appointment.id}:${appointment.id}`; }
export function appointmentIsClient(appointment: WorkspaceAppointment): boolean {
  const contact = appointment.contact;
  // Match the main Appointments page's explicit membership / legacy fallback.
  if (contact && Object.prototype.hasOwnProperty.call(contact, 'client_status')) return contact.client_status === 'client';
  return contact?.last_call_disposition?.trim() === 'Closed';
}
/** Keep range labels in the same viewer timezone used by the appointment query. */
export function appointmentTimeSlot(appointment: WorkspaceAppointment, timeZone = viewerTimeZone()): string {
  if (appointment.all_day) return 'All day';
  const start = new Date(appointment.scheduled_at);
  if (!Number.isFinite(start.getTime())) return 'Time unavailable';
  const format = (date: Date) => new Intl.DateTimeFormat('en-US', {
    timeZone, hour: 'numeric', minute: '2-digit',
  }).format(date).replace(/\s/g, '').toLowerCase();
  const startLabel = format(start);
  const end = new Date(start.getTime() + appointment.duration * 60_000);
  if (!Number.isFinite(appointment.duration) || appointment.duration <= 0 || !Number.isFinite(end.getTime())) return `${startLabel} · End time unavailable`;
  return `${startLabel} - ${format(end)}`;
}
export function appointmentDateLabel(appointment: Pick<WorkspaceAppointment, 'scheduled_at'>, timeZone = viewerTimeZone()): string {
  const date = new Date(appointment.scheduled_at);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', month: 'short', day: 'numeric',
  }).format(date) : 'Date unavailable';
}
export function appointmentStatusBadge(appointment: WorkspaceAppointment, now: Date, allowFollowUp = true, timeZone = viewerTimeZone()): { text: string; tone: string } {
  const disposition = appointment.contact?.last_call_disposition?.trim();
  if (appointment.status === 'no_show' || disposition?.toLowerCase().replace(/[ _-]+/g, ' ') === 'no show') return { text: 'No show', tone: 'no-show' };
  if (appointmentIsClient(appointment)) return { text: 'Client', tone: 'client' };
  if (disposition?.toLowerCase() === 'closed') return { text: 'Closed', tone: 'client' };
  if (/^follow[ -]?up(?: needed)?$/i.test(disposition ?? '')) return { text: 'Follow-up needed', tone: 'needed' };
  const followUp = allowFollowUp ? getAppointmentFollowUpStatus(appointment, now, timeZone) : null;
  if (followUp) return { text: followUp === 'needed' ? 'Follow up needed' : 'Follow up scheduled', tone: followUp };
  if (disposition) return { text: disposition, tone: 'neutral' };
  const status = appointment.status?.replace(/[_-]/g, ' ').trim();
  return { text: status ? status.charAt(0).toUpperCase() + status.slice(1) : 'No Disposition', tone: 'neutral' };
}
/** All day keys and displayed times use the account preference from /api/auth/me. */
export function viewerTimeZone(): string {
  const configured = getStoredUser()?.timezone;
  if (typeof configured === 'string' && configured.trim()) {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: configured }).resolvedOptions().timeZone; } catch { /* invalid legacy preference: use OS fallback */ }
  }
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
export function localDateValue(date: Date, timeZone = viewerTimeZone()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const value = (part: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === part)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function calendarDate(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Choose a valid date.');
  const result = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(result.getTime()) || result.toISOString().slice(0, 10) !== date) throw new Error('Choose a valid date.');
  return result;
}
export function shiftAppointmentDate(date: string, offset: number): string {
  const result = calendarDate(date);
  result.setUTCDate(result.getUTCDate() + offset);
  return result.toISOString().slice(0, 10);
}
export function appointmentDateRange(date: string, timeZone = viewerTimeZone()): { start: Date; end: Date } {
  // Locate the first instant of each calendar day rather than adding 24 hours:
  // daylight-saving transitions can make an account's day 23 or 25 hours long.
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayKey = (ms: number) => {
    const parts = formatter.formatToParts(new Date(ms));
    const value = (part: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === part)?.value;
    return `${value('year')}-${value('month')}-${value('day')}`;
  };
  const boundary = (day: string) => {
    const center = calendarDate(day).getTime();
    let lower = center - 36 * 3_600_000, upper = center + 36 * 3_600_000;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (dayKey(middle) < day) lower = middle + 1; else upper = middle;
    }
    if (dayKey(lower) !== day) throw new Error('Choose a valid date.');
    return lower;
  };
  return { start: new Date(boundary(date)), end: new Date(boundary(shiftAppointmentDate(date, 1)) - 1) };
}

export const appointmentsApi = {
  async list(date: string, timeZone = viewerTimeZone()): Promise<WorkspaceAppointment[]> {
    const { start, end } = appointmentDateRange(date, timeZone);
    const params = new URLSearchParams({ startDate: start.toISOString(), endDate: end.toISOString(), includeExternal: 'true', includeFollowUp: 'true', viewerTimeZone: timeZone });
    const body = await request<WorkspaceAppointment[] | { appointments?: WorkspaceAppointment[]; data?: WorkspaceAppointment[] }>(`/api/appointments?${params}`);
    const rows = Array.isArray(body) ? body : body.appointments ?? body.data;
    if (!Array.isArray(rows)) throw new Error('Unable to read the appointment list. Please refresh.');
    const unique = new Map<string, WorkspaceAppointment>();
    for (const row of rows) {
      if (!row || !['number', 'string'].includes(typeof row.id) || !row.id || typeof row.scheduled_at !== 'string' || !Number.isFinite(Date.parse(row.scheduled_at))) throw new Error('An appointment could not be read. Please refresh.');
      if (isAppointmentVisible(row)) unique.set(appointmentKey(row), row);
    }
    return [...unique.values()].sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at));
  },
  async dispositions(): Promise<AppointmentDisposition[]> {
    const data = await request<{ dispositions: AppointmentDisposition[] }>('/api/dialer/dispositions');
    if (!Array.isArray(data.dispositions)) throw new Error('Unable to read dispositions. Please refresh.');
    return data.dispositions;
  },
  async saveContactDisposition(contactId: number, disposition: string | null): Promise<AppointmentDispositionResult> {
    if (!Number.isSafeInteger(contactId) || contactId <= 0) throw new Error('Choose a valid contact before updating its disposition.');
    const result = await request<AppointmentDispositionResult>(`/api/dialer/contacts/${contactId}/disposition`, {
      // Legacy generic-contact source preserves call dates when editing outside a call.
      method: 'POST', body: JSON.stringify({ disposition, source: 'sms' }),
    });
    if (result.disposition !== null && typeof result.disposition !== 'string') throw new Error('Unable to verify the saved disposition. Refresh before trying again.');
    return result;
  },
  async saveDisposition(appointment: WorkspaceAppointment, disposition: string | null): Promise<AppointmentDispositionResult> {
    const contactId = linkedAppointmentContact(appointment);
    if (!contactId || !Number.isSafeInteger(appointment.id) || Number(appointment.id) <= 0) throw new Error('This appointment has no linked contact. Search for a contact above to take notes.');
    const result = await request<AppointmentDispositionResult>(`/api/dialer/contacts/${contactId}/disposition`, {
      method: 'POST', body: JSON.stringify({ disposition, source: 'appointments', appointmentId: appointment.id }),
    });
    if (result.disposition !== null && typeof result.disposition !== 'string') throw new Error('Unable to verify the saved disposition. Refresh before trying again.');
    return result;
  },
};
