/**
 * Dialer API Service - Backend integration for auth, phone numbers, and call logging.
 *
 * @see dialerblueprint.md Section 3 (Identity & Routing Layer)
 */

import { extractErrorMessage } from '@/utils/extractErrorMessage';

const API_BASE =
  (import.meta.env.VITE_API_BASE as string)?.replace(/\/$/, '') ?? '';

const AUTH_TOKEN_KEY = 'crokodial_auth_token';
const AUTH_USER_KEY = 'crokodial_auth_user';

export interface LoginUser {
  id: number;
  name: string;
  email: string;
  phone?: string | null;
  role?: string | null;
  tenant_id?: number | null;
  [key: string]: unknown;
}

export interface LoginResponse {
  token?: string;
  user: LoginUser;
}

function buildUrl(path: string): string {
  if (!API_BASE) return '';
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Fetch via IPC proxy (Electron) or direct fetch (web).
 * Bypasses CORS when running in Electron by routing through main process.
 */
async function doFetch(url: string, options: RequestInit = {}): Promise<Response> {
  if (!url) return new Response(null, { status: 0 });

  const apiFetch = typeof window !== 'undefined' && window.dialer?.apiFetch;

  if (apiFetch) {
    const headers: Record<string, string> = {};
    const optsHeaders = options.headers as HeadersInit;
    if (optsHeaders && typeof optsHeaders === 'object' && !Array.isArray(optsHeaders)) {
      if (optsHeaders instanceof Headers) {
        optsHeaders.forEach((v, k) => { headers[k] = v; });
      } else {
        Object.assign(headers, optsHeaders as Record<string, string>);
      }
    }
    const body = options.body != null ? String(options.body) : undefined;
    const serialized = await apiFetch(url, {
      method: options.method ?? 'GET',
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body,
    });
    return new Response(serialized.body, {
      status: serialized.status,
      statusText: serialized.statusText,
      headers: serialized.headers,
    });
  }

  return fetch(url, {
    ...options,
    headers: options.headers,
    credentials: 'include',
  });
}

/**
 * Authenticated fetch - attaches JWT to all requests.
 * On 401, clears session (token version bump / logout).
 */
export async function authenticatedFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  if (!url) return new Response(null, { status: 0 });
  const headers = { ...getAuthHeaders(), ...(options.headers as Record<string, string>) };
  const res = await doFetch(url, {
    ...options,
    headers,
  });
  if (res.status === 401) {
    clearSession();
  }
  if (res.status === 403) {
    const cloned = res.clone();
    cloned.json().then((body: unknown) => {
      const b = body as { error?: { code?: string; message?: string } };
      if (b?.error?.code === 'REQUIRES_TENANT') {
        clearSession();
        if (typeof window !== 'undefined') {
          const msg = b.error?.message ?? 'An organization is required. Please create or join one at crokodial.com.';
          window.dispatchEvent(new CustomEvent(REQUIRES_TENANT_EVENT, { detail: { message: msg } }));
        }
      }
    }).catch(() => {});
  }
  return res;
}

/** Event dispatched when session is cleared (e.g. 401). App should listen and redirect to login. */
export const UNAUTHORIZED_EVENT = 'crokodial:unauthorized';

/** Event dispatched when 403 REQUIRES_TENANT. User must create/join an organization. */
export const REQUIRES_TENANT_EVENT = 'crokodial:requires-tenant';

function clearSession(): void {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_USER_KEY);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }
}

export function getStoredUser(): LoginUser | null {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as LoginUser;
  } catch {
    return null;
  }
}

export function isAuthenticated(): boolean {
  return !!localStorage.getItem(AUTH_TOKEN_KEY) || !!getStoredUser();
}

/**
 * Login with email and password. Stores JWT and user in localStorage.
 */
export async function login(email: string, password: string): Promise<LoginUser> {
  const url = buildUrl('/api/auth/login');
  if (!url) throw new Error('API base not configured. Set VITE_API_BASE.');
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    let message = 'Login failed';
    try {
      const body = (await res.json()) as {
        error?: { message?: unknown };
        message?: unknown;
      };
      const raw = body?.error?.message ?? body?.message ?? message;
      message = extractErrorMessage(raw) || 'Login failed';
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  const body = (await res.json()) as { data?: LoginResponse } & LoginResponse;
  const payload = body?.data ?? body;
  const token = payload?.token;
  const user = payload?.user ?? (payload as unknown as LoginUser);
  if (!token || !user || typeof user !== 'object') {
    throw new Error('Invalid login response');
  }
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
  return user;
}

/**
 * Verify token on startup. Returns true if valid; clears session and returns false on 401.
 */
export async function checkAuth(): Promise<boolean> {
  const url = buildUrl('/api/auth/me');
  if (!url) return false;
  const res = await authenticatedFetch(url);
  if (res.status === 401) {
    clearSession();
    return false;
  }
  if (!res.ok) return false;
  try {
    const body = (await res.json()) as { data?: LoginUser } & LoginUser;
    const user = body?.data ?? body;
    if (user && typeof user === 'object' && 'id' in user) {
      localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function logout(): void {
  clearSession();
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T | null> {
  if (!url) return null;
  try {
    const res = await authenticatedFetch(url, {
      ...options,
      headers: { ...getAuthHeaders(), ...options?.headers },
    });
    if (!res.ok) {
      console.warn(`[dialerApi] ${options?.method ?? 'GET'} ${url} failed:`, res.status);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[dialerApi] ${options?.method ?? 'GET'} ${url} error:`, err);
    return null;
  }
}

// --- Response types (minimal; actual backend may differ) ---

export interface PhoneNumbersResponse {
  phoneNumbers?: string[];
  data?: Array<{ e164?: string; phone_number?: string }>;
}

export interface LogCallPayload {
  destinationNumber: string;
  callerNumber: string;
  direction?: 'inbound' | 'outbound';
  leadContext?: {
    leadId?: string;
    leadName?: string;
    leadPhone?: string;
  };
}

export interface SaveDispositionPayload {
  disposition?: string;
  notes?: string;
  [key: string]: unknown;
}

/** Lead from GET /api/dialer/leads */
export interface DialerLead {
  id: number;
  e164: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  state?: string;
  [key: string]: unknown;
}

export interface DialerLeadsResponse {
  leads?: DialerLead[];
  data?: DialerLead[];
  pagination?: { total: number; totalPages: number; limit: number; page?: number };
}

export interface FilterOptionsResponse {
  states?: string[];
  dispositions?: string[];
  timezones?: string[];
  sources?: string[];
}

// --- API functions ---

export async function fetchPhoneNumbers(): Promise<string[]> {
  const url = buildUrl('/api/phone-numbers');
  const body = await fetchJson<PhoneNumbersResponse & { data?: unknown }>(url);
  if (!body) return [];
  const payload = (body as { data?: unknown })?.data ?? body;
  const p = payload as PhoneNumbersResponse & { data?: Array<{ e164?: string; phone_number?: string }> };
  const raw = p.phoneNumbers ?? (Array.isArray(p.data) ? p.data : Array.isArray(payload) ? payload : []);
  return (Array.isArray(raw) ? raw : []).map((d: { e164?: string; phone_number?: string } | string) =>
    typeof d === 'string' ? d : String((d as { e164?: string; phone_number?: string }).e164 ?? (d as { e164?: string; phone_number?: string }).phone_number ?? '').trim()
  ).filter(Boolean);
}

export async function fetchDialerLeads(params: {
  page?: number;
  limit?: number;
  search?: string;
  [key: string]: string | number | undefined;
} = {}): Promise<DialerLead[]> {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== '') searchParams.set(k, String(v));
  });
  const url = buildUrl(`/api/dialer/leads?${searchParams.toString()}`);
  const body = await fetchJson<DialerLeadsResponse & { data?: { leads?: DialerLead[]; data?: DialerLead[] } }>(url);
  if (!body) return [];
  const payload = (body as { data?: unknown })?.data ?? body;
  const leads = (payload as DialerLeadsResponse).leads ?? (payload as { data?: DialerLead[] }).data ?? [];
  return Array.isArray(leads) ? leads : [];
}

export async function fetchFilterOptions(): Promise<FilterOptionsResponse> {
  const url = buildUrl('/api/dialer/filter-options');
  const body = await fetchJson<{ data?: FilterOptionsResponse } & FilterOptionsResponse>(url);
  if (!body) return { states: [], dispositions: [], timezones: [], sources: [] };
  const payload = (body as { data?: unknown })?.data ?? body;
  const p = payload as FilterOptionsResponse;
  return {
    states: Array.isArray(p.states) ? p.states : [],
    dispositions: Array.isArray(p.dispositions) ? p.dispositions : [],
    timezones: Array.isArray(p.timezones) ? p.timezones : [],
    sources: Array.isArray(p.sources) ? p.sources : [],
  };
}

export async function logCallStart(payload: LogCallPayload): Promise<void> {
  // Backend requires contactId; manual dial has no lead context → skip to avoid 400
  const contactId = payload.leadContext?.leadId;
  if (!contactId) return;

  const url = buildUrl('/api/dialer/call');
  if (!url) return;
  try {
    const res = await authenticatedFetch(url, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn('[dialerApi] POST /api/dialer/call failed:', res.status);
    }
  } catch (err) {
    console.warn('[dialerApi] POST /api/dialer/call error:', err);
  }
}

export interface SaveDispositionResult {
  ok: boolean;
  error?: string;
}

export async function saveDisposition(
  contactId: string,
  payload: SaveDispositionPayload
): Promise<SaveDispositionResult> {
  const url = buildUrl(`/api/dialer/contacts/${encodeURIComponent(contactId)}/disposition`);
  if (!url) return { ok: false, error: 'API not configured' };
  try {
    const res = await authenticatedFetch(url, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload),
    });
    if (res.ok) return { ok: true };
    let errMsg = `Save failed (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      const msg =
        typeof body?.message === 'string'
          ? body.message
          : typeof body?.error === 'string'
            ? body.error
            : extractErrorMessage(body, '');
      if (msg) errMsg = msg;
    } catch {
      const text = await res.text();
      if (text) errMsg = text.length <= 120 ? text : `${text.slice(0, 117)}...`;
    }
    return { ok: false, error: errMsg };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg || 'Network error' };
  }
}
