import { authenticatedFetch } from './dialerApiService';
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
  const followUp = allowFollowUp ? getAppointmentFollowUpStatus(appointment, now, timeZone) : null;
  if (followUp) return { text: followUp === 'needed' ? 'Follow up needed' : 'Follow up scheduled', tone: followUp };
  if (disposition) return { text: disposition, tone: 'neutral' };
  const status = appointment.status?.replace(/[_-]/g, ' ').trim();
  return { text: status ? status.charAt(0).toUpperCase() + status.slice(1) : 'No Disposition', tone: 'neutral' };
}
export function localDateValue(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function appointmentDateRange(date: string): { start: Date; end: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Choose a valid date.');
  const start = new Date(`${date}T00:00:00`), end = new Date(`${date}T23:59:59.999`);
  if (!Number.isFinite(start.getTime()) || localDateValue(start) !== date) throw new Error('Choose a valid date.');
  return { start, end };
}
export function shiftAppointmentDate(date: string, offset: number): string {
  const { start } = appointmentDateRange(date); start.setDate(start.getDate() + offset); return localDateValue(start);
}
export function viewerTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

export const appointmentsApi = {
  async list(date: string): Promise<WorkspaceAppointment[]> {
    const { start, end } = appointmentDateRange(date);
    const params = new URLSearchParams({ startDate: start.toISOString(), endDate: end.toISOString(), includeExternal: 'true', includeFollowUp: 'true', viewerTimeZone: viewerTimeZone() });
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
