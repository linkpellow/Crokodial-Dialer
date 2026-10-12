import { authenticatedFetch } from './dialerApiService';
import { appointmentTimeSlot, localDateValue, viewerTimeZone, type WorkspaceAppointment } from './appointmentsApiService';

export type WorkspaceContactFilter = 'all' | 'leads' | 'clients';
export type ContactHistoryFilter = 'all' | 'calls' | 'appointments';
export interface WorkspaceContact {
  id: number;
  name: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  state: string | null;
  clientStatus: 'client' | 'former_client' | null;
  disposition: string | null;
  /** Optional while older platform releases are still serving contact pages. */
  hasAppointment?: boolean;
  appointmentIndicator?: 'no_show' | 'follow_up_needed' | 'client' | null;
}
export interface WorkspaceContactUpdate { id: number; clientStatus: 'client' | 'former_client' | null; disposition: string | null }
export interface CursorPage { hasMore: boolean; nextCursor: string | null }
export interface WorkspaceContactPage extends CursorPage { contacts: WorkspaceContact[] }
interface ContactActivityBase { id: string; occurredAt: string; status: string }
export interface ContactCallActivity extends ContactActivityBase {
  kind: 'call'; callLogId: number; direction: 'inbound' | 'outbound' | null;
  outcome: string | null; disposition?: string | null; durationSeconds: number | null; verified: boolean; source: 'telnyx' | 'legacy';
}
export interface ContactAppointmentActivity extends ContactActivityBase {
  kind: 'appointment'; appointmentId: number; scheduledAt: string; title: string; durationMinutes: number | null;
}
export type ContactActivity = ContactCallActivity | ContactAppointmentActivity;
export interface ContactActivityPage extends CursorPage { contactId: number; items: ContactActivity[] }
const base = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
async function request<T>(path: string): Promise<T> {
  const response = await authenticatedFetch(`${base}${path}`);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? body?.message ?? `Unable to load workspace data (${response.status}).`);
  if (!body) throw new Error('Crokodial returned an unreadable response. Please retry.');
  return body.data ?? body;
}
function validPage(page: CursorPage): boolean {
  return Boolean(page) && typeof page.hasMore === 'boolean' && (page.nextCursor === null || typeof page.nextCursor === 'string') &&
    (!page.hasMore || Boolean(page.nextCursor));
}
function query(filter: string, cursor?: string | null, limit = 50): URLSearchParams {
  const params = new URLSearchParams({ filter, limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  return params;
}
export const workspaceContactsApi = {
  async list({ filter = 'all', search = '', cursor, limit = 50 }: {
    filter?: WorkspaceContactFilter; search?: string; cursor?: string | null; limit?: number;
  } = {}): Promise<WorkspaceContactPage> {
    const params = query(filter, cursor, limit);
    if (search.trim()) params.set('search', search.trim());
    const page = await request<WorkspaceContactPage>(`/api/contacts/workspace?${params}`);
    if (!validPage(page) || !Array.isArray(page.contacts) || page.contacts.some(contact => !contact || !Number.isSafeInteger(contact.id) || contact.id <= 0 || typeof contact.name !== 'string' || (contact.phone !== null && typeof contact.phone !== 'string') || ![null, 'client', 'former_client'].includes(contact.clientStatus) || (contact.hasAppointment !== undefined && typeof contact.hasAppointment !== 'boolean') || (contact.appointmentIndicator !== undefined && ![null, 'no_show', 'follow_up_needed', 'client'].includes(contact.appointmentIndicator)))) throw new Error('Unable to read the contact list. Please retry.');
    if (cursor && page.hasMore && cursor === page.nextCursor) throw new Error('The contact list could not advance. Please retry.');
    return page;
  },
  async history(contactId: number, { filter = 'all', cursor, limit = 50 }: {
    filter?: ContactHistoryFilter; cursor?: string | null; limit?: number;
  } = {}): Promise<ContactActivityPage> {
    if (!Number.isSafeInteger(contactId) || contactId <= 0) throw new Error('Choose a valid contact to view history.');
    const page = await request<ContactActivityPage>(`/api/contacts/workspace/${contactId}/activity?${query(filter, cursor, limit)}`);
    if (!page || page.contactId !== contactId || !validPage(page) || !Array.isArray(page.items) || page.items.some(item => !item || typeof item.id !== 'string' || typeof item.status !== 'string' || !['call', 'appointment'].includes(item.kind) || !Number.isFinite(Date.parse(item.occurredAt)) || (item.kind === 'call' ? ![null, 'inbound', 'outbound'].includes(item.direction) || (item.outcome !== null && typeof item.outcome !== 'string') || (item.durationSeconds !== null && !Number.isFinite(item.durationSeconds)) || typeof item.verified !== 'boolean' : typeof item.title !== 'string' || !Number.isFinite(Date.parse(item.scheduledAt)) || (item.durationMinutes !== null && !Number.isFinite(item.durationMinutes))))) throw new Error('Unable to verify this contact’s history. Please retry.');
    if (cursor && page.hasMore && cursor === page.nextCursor) throw new Error('The history could not advance. Please retry.');
    return page;
  },
};
export function workspaceContactName(contact: WorkspaceContact): string { return contact.name.trim() || [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || contact.phone || 'Unnamed contact'; }
export function workspaceContactInitials(contact: WorkspaceContact): string {
  const words = workspaceContactName(contact).split(/\s+/).filter(word => /[a-z]/i.test(word));
  return words.length ? `${words[0][0]}${words.length > 1 ? words[words.length - 1][0] : ''}`.toUpperCase() : '';
}
export function workspaceContactPhone(phone: string | null): string {
  if (!phone) return 'No phone number';
  const digits = phone.replace(/\D/g, '');
  const national = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  return national.length === 10 ? `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}` : phone;
}
/** Never infer an appointment outcome from a lead's call disposition alone. */
export function workspaceContactIndicator(contact: WorkspaceContact): { tone: 'client' | 'follow-up' | 'no-show'; label: string } | null {
  const disposition = contact.disposition?.trim().replace(/[_-]+/g, ' ').toLowerCase();
  if (contact.clientStatus === 'client' || disposition === 'closed') return { tone: 'client', label: contact.clientStatus === 'client' ? 'Client' : 'Closed' };
  if (contact.hasAppointment !== true) return null;
  if (contact.appointmentIndicator === 'no_show') return { tone: 'no-show', label: 'No show' };
  if (contact.appointmentIndicator === 'follow_up_needed') return { tone: 'follow-up', label: 'Follow-up needed' };
  if (contact.appointmentIndicator === 'client') return { tone: 'client', label: 'Client' };
  return null;
}
export function activityTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-US', { timeZone: viewerTimeZone(), hour: 'numeric', minute: '2-digit' }).format(date).replace(/\s/g, '').toLowerCase() : 'Time unavailable';
}
export function activityDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.floor(seconds), hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, remainder = total % 60;
  return hours ? `${hours}h ${minutes}m ${remainder}s` : minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}
export function activityStatus(value: string | null): string {
  const clean = value?.trim().replace(/[_-]+/g, ' ').toLowerCase();
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : 'Status unavailable';
}
export function activitySlot(activity: ContactAppointmentActivity): string {
  return appointmentTimeSlot({ scheduled_at: activity.scheduledAt, duration: activity.durationMinutes ?? NaN } as WorkspaceAppointment);
}
export function activityDateHeading(value: string, now = new Date()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Date unavailable';
  const timeZone = viewerTimeZone(), key = localDateValue(date, timeZone), today = localDateValue(now, timeZone);
  const previousDay = new Date(`${today}T12:00:00Z`); previousDay.setUTCDate(previousDay.getUTCDate() - 1);
  if (key === today) return 'Today';
  if (key === previousDay.toISOString().slice(0, 10)) return 'Yesterday';
  return date.toLocaleDateString('en-US', { timeZone, month: 'short', day: 'numeric', ...(key.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' as const } : {}) });
}
/** Keep stable row identity while cursors overlap after concurrent catalog updates. */
export function mergeWorkspaceRows<T extends { id: string | number }>(previous: T[], next: T[]): T[] {
  const rows = new Map(previous.map(row => [row.id, row]));
  next.forEach(row => rows.set(row.id, row));
  return [...rows.values()];
}

/** Reconcile the newest ID-descending page, removing contacts no longer in this filter. */
export function mergeWorkspaceContactHead(previous: WorkspaceContact[], head: WorkspaceContact[]): WorkspaceContact[] {
  if (!head.length) return [];
  const boundary = head[head.length - 1].id;
  const fresh = new Set(head.map(contact => contact.id));
  return [...head, ...previous.filter(contact => contact.id < boundary && !fresh.has(contact.id))];
}
export function patchWorkspaceContactRows(rows: WorkspaceContact[], filter: WorkspaceContactFilter, update: WorkspaceContactUpdate): WorkspaceContact[] {
  return rows.flatMap(contact => {
    if (contact.id !== update.id) return [contact];
    if ((filter === 'clients' && update.clientStatus !== 'client') || (filter === 'leads' && update.clientStatus === 'client')) return [];
    return [{ ...contact, clientStatus: update.clientStatus, disposition: update.disposition }];
  });
}
