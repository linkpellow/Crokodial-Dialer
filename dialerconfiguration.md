# Crokodial Dialer — Contacts Screen Implementation Guide

Everything needed to add a fully-functional "All Contacts" screen to this Electron dialer,
end-to-end aligned with the Crokodial backend API and the existing codebase conventions.

---

## Table of Contents

1. [Architecture Fit](#1-architecture-fit)
2. [Type Definitions](#2-type-definitions)
3. [API Service Layer](#3-api-service-layer)
4. [Navigation — DialerShell Update](#4-navigation--dialershell-update)
5. [ContactsPage Component](#5-contactspage-component)
6. [DialerPage — Add Contacts Entry](#6-dialerpage--add-contacts-entry)
7. [Design System Reference](#7-design-system-reference)
8. [Error Handling & Entitlement](#8-error-handling--entitlement)
9. [Verification Checklist](#9-verification-checklist)

---

## 1. Architecture Fit

The contacts screen slots into the existing single-view-stack navigation inside `DialerShell`.
No router library is needed — the pattern already established for `'settings'` is extended to
`'contacts'`.

```
App.tsx
  └─ DialerShell                  view: 'dialer' | 'settings' | 'contacts'
       ├─ DialerPage               (view === 'dialer')
       ├─ SettingsPage             (view === 'settings')
       └─ ContactsPage   ← NEW    (view === 'contacts')
```

**Data flow:**

```
ContactsPage
  → fetchContacts()          (dialerApiService.ts)
    → GET /api/contacts      (Crokodial backend, tenant-scoped, JWT-authenticated)
      → Contact[]            (aligned with shared/src/types.ts Contact DTO)
```

**Call initiation from Contacts:**

```
User taps phone number on a contact card
  → actions.startCallWithLead(contact.e164, leadContext)
  → onBack() — navigate back to DialerPage to show call UI
```

---

## 2. Type Definitions

Add the following interfaces to `src/renderer/services/dialerApiService.ts`, after the
existing `DialerLead` interface.

```typescript
// ─── Contact (aligned with Crokodial shared/src/types.ts Contact DTO) ────────

export interface Contact {
  id: number;
  e164: string;
  opt_status: 'opted_in' | 'opted_out' | 'unknown';
  // Name — backend normalises both casings; prefer camelCase, fall back to snake_case
  firstName?: string;
  lastName?: string;
  first_name?: string;
  last_name?: string;
  // Contact info
  email?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  address?: string;
  // Metadata
  custom_fields?: string;
  tags?: string;
  is_pinned?: number;
  list_id?: number;
  user_id?: number;
  tenant_id?: number;
  // Timestamps
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
  // Dialer history
  last_call_disposition?: string;
  last_call_date?: string;
  call_notes?: string;
  total_calls?: number;
  // Opt-out / compliance
  opt_out_timestamp?: string;
  opt_out_reason?: string;
  opted_in_at?: string;
  opt_in_source?: string;
  // Misc
  locale?: string;
  geo_country?: string;
  geo_region?: string;
  client_status?: string;
}

export interface ContactsPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export interface ContactsResponse {
  contacts: Contact[];
  pagination: ContactsPagination;
}

// Thrown when the backend returns 403 ENTITLEMENT_DENIED:dialer
export class ContactsEntitlementError extends Error {
  constructor() {
    super('Contacts require an active dialer plan. Please check your subscription at crokodial.com.');
    this.name = 'ContactsEntitlementError';
  }
}
```

---

## 3. API Service Layer

Add the following two functions to `src/renderer/services/dialerApiService.ts`.
They follow the exact same patterns as `fetchDialerLeads` (same auth wrapper,
same envelope unwrapping, same error handling style).

```typescript
// ─── Contacts API ─────────────────────────────────────────────────────────────

const CONTACTS_EMPTY: ContactsResponse = {
  contacts: [],
  pagination: { page: 1, limit: 25, total: 0, totalPages: 0, hasMore: false },
};

/**
 * GET /api/contacts — paginated, tenant-scoped contact list.
 *
 * Rules aligned with backend:
 *  - search is only sent when >= 3 characters (server returns empty for shorter)
 *  - includePagination is always true so the caller always gets pagination metadata
 *  - throws ContactsEntitlementError on 403 ENTITLEMENT_DENIED:dialer
 *  - throws Error on any other failure
 */
export async function fetchContacts(params: {
  page?: number;
  limit?: number;
  search?: string;
  filter?: 'all' | 'unread' | 'recent' | 'archived';
  tagId?: number | null;
} = {}): Promise<ContactsResponse> {
  const sp = new URLSearchParams();
  sp.set('includePagination', 'true');
  if (params.page && params.page > 1) sp.set('page', String(params.page));
  if (params.limit) sp.set('limit', String(params.limit));
  if (params.search && params.search.trim().length >= 3) sp.set('search', params.search.trim());
  if (params.filter && params.filter !== 'all') sp.set('filter', params.filter);
  if (params.tagId != null) sp.set('tagId', String(params.tagId));

  const url = buildUrl(`/api/contacts?${sp.toString()}`);
  if (!url) return CONTACTS_EMPTY;

  let res: Response;
  try {
    res = await authenticatedFetch(url);
  } catch (err) {
    throw new Error(extractErrorMessage(err) || 'Network error loading contacts');
  }

  if (res.status === 403) {
    let code = '';
    try {
      const body = (await res.clone().json()) as { error?: { code?: string } };
      code = body?.error?.code ?? '';
    } catch { /* ignore */ }
    if (code.startsWith('ENTITLEMENT_DENIED')) throw new ContactsEntitlementError();
    throw new Error('Access denied. Your account may not have contacts access.');
  }

  if (!res.ok) {
    let msg = `Server error (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string; error?: { message?: string } };
      msg = extractErrorMessage(body?.error?.message ?? body?.message ?? msg) || msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  try {
    const raw = (await res.json()) as { data?: unknown } & unknown;
    const payload = (raw as { data?: unknown })?.data ?? raw;
    const p = payload as { contacts?: Contact[]; pagination?: ContactsPagination };
    return {
      contacts: Array.isArray(p.contacts) ? p.contacts : [],
      pagination: p.pagination ?? CONTACTS_EMPTY.pagination,
    };
  } catch {
    return CONTACTS_EMPTY;
  }
}

/**
 * GET /api/contacts/:id — single contact detail.
 * Returns null if not found (404) or not entitled (403).
 */
export async function fetchContact(id: number): Promise<Contact | null> {
  const url = buildUrl(`/api/contacts/${encodeURIComponent(String(id))}`);
  const body = await fetchJson<{ data?: Contact } & Contact>(url);
  if (!body) return null;
  const payload = (body as { data?: Contact })?.data ?? body;
  return (payload as Contact)?.id ? (payload as Contact) : null;
}
```

---

## 4. Navigation — DialerShell Update

Replace `src/renderer/components/DialerShell.tsx` entirely:

```typescript
/**
 * DialerShell - Wraps DialerPage, SettingsPage, and ContactsPage with shared useDialer state.
 * Manages navigation between dialer, settings, and contacts views.
 */

import { useState } from 'react';
import { useDialer } from '@/renderer/hooks/useDialer';
import { DialerPage } from '@/renderer/components/DialerPage';
import { SettingsPage } from '@/renderer/components/SettingsPage';
import { ContactsPage } from '@/renderer/components/ContactsPage';

interface DialerShellProps {
  onLogout: () => void;
}

type AppView = 'dialer' | 'settings' | 'contacts';

export function DialerShell({ onLogout }: DialerShellProps) {
  const { state, actions } = useDialer();
  const [view, setView] = useState<AppView>('dialer');

  if (view === 'settings') {
    return (
      <SettingsPage
        state={state}
        actions={actions}
        onBack={() => setView('dialer')}
      />
    );
  }

  if (view === 'contacts') {
    return (
      <ContactsPage
        actions={actions}
        onBack={() => setView('dialer')}
      />
    );
  }

  return (
    <DialerPage
      state={state}
      actions={actions}
      onLogout={onLogout}
      onOpenSettings={() => setView('settings')}
      onOpenContacts={() => setView('contacts')}
    />
  );
}
```

---

## 5. ContactsPage Component

Create `src/renderer/components/ContactsPage.tsx`:

```typescript
/**
 * ContactsPage - All Contacts screen.
 *
 * Displays the tenant-scoped contact list from GET /api/contacts.
 * Supports search (≥3 chars), pagination (25/page), and one-tap dialling.
 *
 * Design aligned with SettingsPage and DialerPage:
 *  - Same green gradient background
 *  - Same glass header with back button
 *  - Framer Motion animations
 *  - Lucide React icons
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, Phone, Search, User, ChevronLeft as Prev, ChevronRight as Next } from 'lucide-react';
import {
  fetchContacts,
  ContactsEntitlementError,
  type Contact,
  type ContactsPagination,
} from '@/renderer/services/dialerApiService';
import type { UseDialerActions } from '@/renderer/hooks/useDialer';

// ─── Props ────────────────────────────────────────────────────────────────────

interface ContactsPageProps {
  actions: UseDialerActions;
  onBack: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function contactDisplayName(c: Contact): string {
  const first = c.firstName ?? c.first_name ?? '';
  const last = c.lastName ?? c.last_name ?? '';
  const full = `${first} ${last}`.trim();
  return full || c.e164;
}

function contactInitials(c: Contact): string {
  const first = c.firstName ?? c.first_name ?? '';
  const last = c.lastName ?? c.last_name ?? '';
  if (first && last) return `${first[0]}${last[0]}`.toUpperCase();
  if (first) return first.slice(0, 2).toUpperCase();
  return c.e164.slice(-2);
}

function formatPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return e164;
}

const OPT_BADGE: Record<Contact['opt_status'], { label: string; color: string; bg: string }> = {
  opted_in:  { label: 'Opted In',  color: 'rgba(52,199,89,1)',   bg: 'rgba(52,199,89,0.18)' },
  opted_out: { label: 'Opted Out', color: 'rgba(255,69,58,1)',   bg: 'rgba(255,69,58,0.18)' },
  unknown:   { label: 'Unknown',   color: 'rgba(255,255,255,0.5)', bg: 'rgba(255,255,255,0.08)' },
};

const LIMIT = 25;
const SEARCH_DEBOUNCE_MS = 400;

const btnTap   = { scale: 0.94 };
const btnHover = { scale: 1.02 };

// ─── Component ────────────────────────────────────────────────────────────────

export function ContactsPage({ actions, onBack }: ContactsPageProps) {
  const [contacts, setContacts]     = useState<Contact[]>([]);
  const [pagination, setPagination] = useState<ContactsPagination | null>(null);
  const [page, setPage]             = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [entitlementDenied, setEntitlementDenied] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Search debounce: only fire when ≥ 3 chars or cleared ──
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const trimmed = searchInput.trim();
      // Enforce backend rule: search only activates at 3+ chars
      const next = trimmed.length === 0 || trimmed.length >= 3 ? trimmed : '';
      setActiveSearch(next);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchInput]);

  // ── Fetch contacts on page / search change ──
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchContacts({
        page,
        limit: LIMIT,
        search: activeSearch || undefined,
      });
      setContacts(result.contacts);
      setPagination(result.pagination);
      setEntitlementDenied(false);
    } catch (err) {
      if (err instanceof ContactsEntitlementError) {
        setEntitlementDenied(true);
        setContacts([]);
        setPagination(null);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load contacts');
      }
    } finally {
      setLoading(false);
    }
  }, [page, activeSearch]);

  useEffect(() => { load(); }, [load]);

  // ── Dial a contact ──
  function dialContact(contact: Contact) {
    actions.startCallWithLead(contact.e164, {
      leadId: String(contact.id),
      leadName: contactDisplayName(contact),
      leadPhone: contact.e164,
      state: contact.state,
    });
    onBack(); // switch to DialerPage so call UI is visible
  }

  // ── Pagination bounds ──
  const totalPages  = pagination?.totalPages ?? 1;
  const hasPrev     = page > 1;
  const hasNext     = page < totalPages;

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div
      className="h-full flex flex-col overflow-hidden"
      style={{
        WebkitAppRegion: 'drag' as React.CSSProperties['WebkitAppRegion'],
        background: 'radial-gradient(ellipse 120% 80% at 50% 30%, #a8e063 0%, #7cb342 25%, #5a8a0f 55%, #2d5016 100%)',
        border: '1px solid rgba(255,255,255,0.12)',
      }}
    >
      {/* ── Header ── */}
      <motion.header
        className="shrink-0 flex flex-col border-b border-white/10"
        style={{
          background: 'rgba(26, 61, 26, 0.6)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
        }}
      >
        <div className="flex items-center justify-between px-3 py-2.5">
          <motion.button
            type="button"
            onClick={onBack}
            whileTap={btnTap}
            whileHover={btnHover}
            className="flex items-center gap-1.5 text-white/95 font-medium text-sm"
            style={{ WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'] }}
          >
            <ChevronLeft size={18} />
            Back
          </motion.button>

          <h1 className="text-white/95 font-semibold text-sm tracking-wide">Contacts</h1>

          {/* Total count badge */}
          <div className="w-12 flex justify-end">
            {pagination && (
              <span
                className="text-xs font-medium px-1.5 py-0.5 rounded"
                style={{ background: 'rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.75)' }}
              >
                {pagination.total.toLocaleString()}
              </span>
            )}
          </div>
        </div>

        {/* ── Search bar ── */}
        <div
          className="px-3 pb-2.5"
          style={{ WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'] }}
        >
          <div className="relative">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: 'rgba(255,255,255,0.4)' }}
            />
            <input
              type="search"
              placeholder="Search name, phone, email…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="w-full pl-8 pr-3 py-2 rounded-lg text-sm text-white placeholder-white/35 focus:outline-none focus:ring-2 focus:ring-white/30"
              style={{
                background: 'rgba(26, 61, 26, 0.7)',
                border: '1px solid rgba(255,255,255,0.1)',
                boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.25), inset 0 -1px 0 rgba(255,255,255,0.05)',
              }}
            />
            {/* Search requires 3+ chars hint */}
            {searchInput.trim().length > 0 && searchInput.trim().length < 3 && (
              <p className="mt-1 text-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>
                Type {3 - searchInput.trim().length} more character{3 - searchInput.trim().length !== 1 ? 's' : ''} to search
              </p>
            )}
          </div>
        </div>
      </motion.header>

      {/* ── Body ── */}
      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">

        {/* Entitlement denied */}
        {entitlementDenied && (
          <div className="flex-1 flex items-center justify-center p-6 text-center">
            <div>
              <p className="text-white/90 text-sm font-medium mb-1">Contacts unavailable</p>
              <p className="text-white/55 text-xs leading-relaxed">
                Your current plan does not include contacts access.<br />
                Visit <span className="text-lime-300">crokodial.com</span> to upgrade.
              </p>
            </div>
          </div>
        )}

        {/* Generic error */}
        {error && !entitlementDenied && (
          <div className="flex-1 flex items-center justify-center p-6 text-center">
            <div>
              <p className="text-red-300/90 text-sm font-medium mb-2">Could not load contacts</p>
              <p className="text-white/55 text-xs mb-3">{error}</p>
              <motion.button
                type="button"
                onClick={() => load()}
                whileTap={btnTap}
                whileHover={btnHover}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-white/90"
                style={{
                  background: 'rgba(255,255,255,0.12)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
                }}
              >
                Retry
              </motion.button>
            </div>
          </div>
        )}

        {/* Loading */}
        {loading && !error && !entitlementDenied && (
          <div className="flex-1 flex items-center justify-center">
            <motion.div
              className="w-5 h-5 rounded-full border-2 border-white/20 border-t-white/80"
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }}
            />
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && !entitlementDenied && contacts.length === 0 && (
          <div className="flex-1 flex items-center justify-center p-6 text-center">
            <div>
              <User size={28} className="mx-auto mb-2" style={{ color: 'rgba(255,255,255,0.25)' }} />
              <p className="text-white/60 text-sm">
                {activeSearch ? 'No contacts match your search' : 'No contacts yet'}
              </p>
            </div>
          </div>
        )}

        {/* Contact list */}
        {!loading && !error && !entitlementDenied && contacts.length > 0 && (
          <AnimatePresence mode="wait">
            <motion.ul
              key={`${page}-${activeSearch}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="flex-1 overflow-y-auto px-2 py-2 space-y-1.5"
              style={{ WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'] }}
            >
              {contacts.map((contact) => {
                const name    = contactDisplayName(contact);
                const initials = contactInitials(contact);
                const phone   = formatPhone(contact.e164);
                const badge   = OPT_BADGE[contact.opt_status] ?? OPT_BADGE.unknown;
                const sub     = [contact.email, contact.city, contact.state]
                  .filter(Boolean).join(' · ');

                return (
                  <motion.li
                    key={contact.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex items-center gap-2.5 px-2.5 py-2 rounded-xl"
                    style={{
                      background: 'rgba(26, 61, 26, 0.45)',
                      border: '1px solid rgba(255,255,255,0.07)',
                    }}
                  >
                    {/* Avatar */}
                    <div
                      className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold"
                      style={{ background: 'rgba(52,199,89,0.25)', color: 'rgba(255,255,255,0.85)' }}
                    >
                      {initials}
                    </div>

                    {/* Details */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-white/90 text-xs font-medium truncate">{name}</span>
                        <span
                          className="shrink-0 text-[10px] font-medium px-1.5 py-px rounded"
                          style={{ color: badge.color, background: badge.bg }}
                        >
                          {badge.label}
                        </span>
                      </div>
                      <p className="text-white/50 text-[11px] truncate">{sub || phone}</p>
                    </div>

                    {/* Call button */}
                    <motion.button
                      type="button"
                      onClick={() => dialContact(contact)}
                      whileTap={btnTap}
                      whileHover={btnHover}
                      title={`Call ${phone}`}
                      className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
                      style={{
                        background: 'rgba(52,199,89,0.25)',
                        border: '1px solid rgba(52,199,89,0.3)',
                        color: 'rgba(140,255,70,0.9)',
                      }}
                    >
                      <Phone size={13} />
                    </motion.button>
                  </motion.li>
                );
              })}
            </motion.ul>
          </AnimatePresence>
        )}

        {/* ── Pagination ── */}
        {!entitlementDenied && !error && (pagination?.totalPages ?? 0) > 1 && (
          <div
            className="shrink-0 flex items-center justify-between px-3 py-2 border-t border-white/10"
            style={{ WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'] }}
          >
            <motion.button
              type="button"
              onClick={() => setPage((p) => p - 1)}
              disabled={!hasPrev}
              whileTap={hasPrev ? btnTap : {}}
              className="w-7 h-7 rounded-md flex items-center justify-center transition-opacity"
              style={{
                background: 'rgba(255,255,255,0.08)',
                color: hasPrev ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.2)',
                cursor: hasPrev ? 'pointer' : 'default',
              }}
              aria-label="Previous page"
            >
              <Prev size={14} />
            </motion.button>

            <span className="text-white/55 text-xs">
              {page} / {totalPages}
            </span>

            <motion.button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasNext}
              whileTap={hasNext ? btnTap : {}}
              className="w-7 h-7 rounded-md flex items-center justify-center transition-opacity"
              style={{
                background: 'rgba(255,255,255,0.08)',
                color: hasNext ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.2)',
                cursor: hasNext ? 'pointer' : 'default',
              }}
              aria-label="Next page"
            >
              <Next size={14} />
            </motion.button>
          </div>
        )}
      </main>
    </div>
  );
}
```

---

## 6. DialerPage — Add Contacts Entry

### 6a. Add the `onOpenContacts` prop

In `src/renderer/components/DialerPage.tsx`, update the props interface and destructuring:

```typescript
// Before
interface DialerPageProps {
  state: import('@/renderer/hooks/useDialer').UseDialerState;
  actions: import('@/renderer/hooks/useDialer').UseDialerActions;
  onLogout: () => void;
  onOpenSettings: () => void;
}

export function DialerPage({ state, actions, onLogout, onOpenSettings }: DialerPageProps) {
```

```typescript
// After
interface DialerPageProps {
  state: import('@/renderer/hooks/useDialer').UseDialerState;
  actions: import('@/renderer/hooks/useDialer').UseDialerActions;
  onLogout: () => void;
  onOpenSettings: () => void;
  onOpenContacts: () => void;
}

export function DialerPage({ state, actions, onLogout, onOpenSettings, onOpenContacts }: DialerPageProps) {
```

### 6b. Add "Contacts" to the 3-dot dropdown menu

Inside the `openDropdown === 'menu'` dropdown, add a Contacts entry **above** Settings.
Import `Users` from `lucide-react` alongside the other icons.

```tsx
// Add to lucide-react import:
import { ..., Users } from 'lucide-react';

// In the dropdown menu (before the Settings button):
<button
  type="button"
  onClick={() => { onOpenContacts(); setOpenDropdown(null); }}
  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-white/85 hover:text-white hover:bg-white/8 transition-colors text-left"
>
  <Users size={13} className="shrink-0 opacity-70" />
  Contacts
</button>
<div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '2px 0' }} />
```

Final dropdown order: **Contacts → Settings → (divider) → Log out**

---

## 7. Design System Reference

All styling must match the existing components. Key tokens:

| Element | Value |
|---|---|
| Page background | `radial-gradient(ellipse 120% 80% at 50% 30%, #a8e063 0%, #7cb342 25%, #5a8a0f 55%, #2d5016 100%)` |
| Header background | `rgba(26, 61, 26, 0.6)` + `backdropFilter: blur(12px)` |
| Card background | `rgba(26, 61, 26, 0.45)` + `border: 1px solid rgba(255,255,255,0.07)` |
| Primary green | `rgba(52, 199, 89, …)` — call buttons, active states |
| Text primary | `rgba(255, 255, 255, 0.90)` |
| Text secondary | `rgba(255, 255, 255, 0.50–0.60)` |
| Text muted | `rgba(255, 255, 255, 0.35–0.40)` |
| Button tap | `{ scale: 0.94 }` |
| Button hover | `{ scale: 1.02 }` |
| Drag region | `WebkitAppRegion: 'drag'` on containers, `'no-drag'` on all interactive elements |
| Animations | `framer-motion` — `AnimatePresence`, `motion.*`, spring/ease transitions |
| Icons | `lucide-react` — `size={13|14|18}` depending on context |

---

## 8. Error Handling & Entitlement

### HTTP status mapping

| Status | Cause | UI behaviour |
|---|---|---|
| 401 | Session expired | `authenticatedFetch` auto-calls `clearSession()` → app redirects to login |
| 403 `ENTITLEMENT_DENIED:dialer` | Plan doesn't include dialer | Show upgrade message, no retry spinner |
| 403 other | Tenant missing / misconfigured | Show "Access denied" message with retry |
| 404 | Single contact not found | Return `null` (silent) |
| 5xx | Server error | Show error message with Retry button |
| Network failure | Offline / CORS | Show error message with Retry button |

### Entitlement gate flow

```
fetchContacts()
  ↓ 403 response
  ↓ parse body.error.code
  ↓ code starts with 'ENTITLEMENT_DENIED'
  → throw ContactsEntitlementError

ContactsPage.load()
  ↓ catch ContactsEntitlementError
  → setEntitlementDenied(true)   // shows upgrade message, no retry
  ↓ catch Error
  → setError(err.message)        // shows error + Retry button
```

### Search constraint

The backend silently returns an empty result for search terms shorter than 3 characters.
The component enforces this on the client before sending the request:

```typescript
if (params.search && params.search.trim().length >= 3) sp.set('search', params.search.trim());
```

The search input also shows a live hint: *"Type N more character(s) to search"* while
`searchInput.trim().length` is between 1 and 2.

---

## 9. Verification Checklist

Before shipping, verify each of the following manually:

### Data correctness
- [ ] Pick a known contact from the backend DB; confirm it appears in the Contacts screen with correct name, phone, email, city/state, opt status
- [ ] Verify `contactDisplayName()` falls back correctly when only `first_name`/`last_name` (legacy) columns are populated

### Tenant isolation
- [ ] Log in as User A (Tenant 1); log in as User B (Tenant 2) in a separate session
- [ ] Confirm contacts visible to User A never include User B's contacts and vice versa

### Search behaviour
- [ ] 1–2 character input → hint shown, no API call fired, empty results
- [ ] 3+ character input → results filtered by name, phone, or email
- [ ] Clearing search → returns to full unfiltered list, page resets to 1
- [ ] Debounce works: rapid typing triggers only one request

### Pagination
- [ ] Page 1 shows correct first `LIMIT` contacts
- [ ] Next/Prev buttons advance/retreat correctly
- [ ] Page counter (`X / Y`) matches `pagination.totalPages`
- [ ] Prev button is disabled on page 1; Next button is disabled on last page
- [ ] Changing search term resets to page 1

### Entitlement
- [ ] When dialer feature is disabled on the user's plan, `GET /api/contacts` returns 403 with `ENTITLEMENT_DENIED:dialer`
- [ ] ContactsPage shows upgrade message, no loading spinner, no retry button
- [ ] No console errors — error is handled gracefully

### Error handling
- [ ] Simulate network failure: error message + Retry button appear
- [ ] Click Retry: `load()` is re-invoked, resolves correctly when connectivity returns
- [ ] 5xx from server: error message shown, not a blank screen

### Call initiation
- [ ] Tap the green call button on a contact card
- [ ] App navigates back to DialerPage
- [ ] Call starts to the correct number
- [ ] `leadContext` is populated (leadId, leadName, leadPhone, state) so DispositionModal appears after call ends

### Drag regions
- [ ] Window can be dragged by the header area
- [ ] Search input, Back button, contact cards, call buttons are all non-draggable and respond to clicks

### Navigation
- [ ] Back button returns to DialerPage without resetting dialer state
- [ ] Opening Contacts while a call is in progress: should ideally be prevented (the 3-dot menu is hidden during calls via `!isInCall`, so this is automatic)
- [ ] Contacts entry appears in the 3-dot dropdown menu above Settings

---

## Summary of Files Changed

| File | Change |
|---|---|
| `src/renderer/services/dialerApiService.ts` | Add `Contact`, `ContactsPagination`, `ContactsResponse`, `ContactsEntitlementError` types; add `fetchContacts()` and `fetchContact()` functions |
| `src/renderer/components/DialerShell.tsx` | Add `'contacts'` to `AppView` union; render `ContactsPage`; pass `onOpenContacts` to `DialerPage` |
| `src/renderer/components/ContactsPage.tsx` | **New file** — full contacts screen |
| `src/renderer/components/DialerPage.tsx` | Add `onOpenContacts` prop; add `Users` icon import; add Contacts entry to 3-dot dropdown |
