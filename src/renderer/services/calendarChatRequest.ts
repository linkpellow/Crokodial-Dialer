export type CalendarChatRequest = {
  kind: 'google-calendar';
  mode: 'read' | 'create' | 'update' | 'delete';
  eventId?: string;
  summary?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  needsClarification?: string;
};

export interface CalendarParseContext { now?: number; timeZone?: string }

const explicitCalendar = /\b(?:google\s+calendar|my\s+calendar|calendar\s+event)\b/i;
const unsafeControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function bounded(value: string | undefined, maximum: number): string | undefined {
  const result = value?.trim().replace(/^[\s"'“”‘’:,—-]+|[\s"'“”‘’.,!?]+$/g, '').replace(/\s+/g, ' ');
  return result && result.length <= maximum && !unsafeControls.test(result) ? result : undefined;
}

function iso(value: string | undefined): string | undefined {
  const candidate = bounded(value, 100);
  if (!candidate) return undefined;
  const instant = Date.parse(candidate);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : undefined;
}

function eventId(source: string): string | undefined {
  const match = source.match(/\b(?:event\s+(?:id\s*)?|id\s*[:#]\s*)([a-z0-9_-]{5,1024})\b/i);
  return bounded(match?.[1], 1024);
}

function title(source: string): string | undefined {
  const quoted = source.match(/["“]([^"”]{1,500})["”]/)?.[1];
  const named = source.match(/\b(?:titled|called|named)\s+(.+?)(?=\s+(?:from|starting|on|at)\b|$)/i)?.[1];
  return bounded(quoted ?? named, 500);
}

function range(source: string): { start?: string; end?: string } {
  const match = source.match(/\bfrom\s+(.+?)\s+(?:to|until|through)\s+(.+?)(?=\s+(?:with\s+(?:description|location)|located\s+at|and\s+(?:invite|add))\b|$)/i);
  return match ? { start: iso(match[1]), end: iso(match[2]) } : {};
}

const WEEKDAYS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const ZONES: Record<string, string> = { et: 'America/New_York', est: 'America/New_York', edt: 'America/New_York', ct: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago', mt: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver', pt: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', utc: 'UTC', gmt: 'UTC' };

function validZone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true; } catch { return false; }
}

function requestedZone(source: string, fallback: string): string {
  const iana = source.match(/\b([A-Z][a-z]+\/[A-Z][A-Za-z_-]+)\b/)?.[1];
  if (iana && validZone(iana)) return iana;
  const abbreviation = source.match(/\b(ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT|UTC|GMT)\b/i)?.[1].toLowerCase();
  return abbreviation && ZONES[abbreviation] ? ZONES[abbreviation] : validZone(fallback) ? fallback : 'UTC';
}

function zonedParts(instant: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'long' });
  const values = Object.fromEntries(formatter.formatToParts(instant).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), weekday: WEEKDAYS[values.weekday.toLowerCase()] };
}

function wallInstant(date: { year: number; month: number; day: number }, hour: number, minute: number, timeZone: string): number {
  const target = Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0, 0);
  let guess = target;
  for (let index = 0; index < 4; index++) {
    const observed = zonedParts(guess, timeZone);
    const represented = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, 0, 0);
    const delta = target - represented;
    if (!delta) break;
    guess += delta;
  }
  return guess;
}

function addDays(date: { year: number; month: number; day: number }, days: number) {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function relativeDate(source: string, now: number, timeZone: string): { year: number; month: number; day: number } | undefined {
  const current = zonedParts(now, timeZone), today = { year: current.year, month: current.month, day: current.day };
  if (/\btomorrow\b/i.test(source)) return addDays(today, 1);
  if (/\btoday\b/i.test(source)) return today;
  const match = source.match(/\b(?:(next)\s+)?(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/i);
  if (!match) return undefined;
  const requested = WEEKDAYS[match[2].toLowerCase()];
  let days = (requested - current.weekday + 7) % 7;
  if (match[1] || days === 0) days += 7;
  return addDays(today, days);
}

function clock(source: string): { hour?: number; minute?: number; ambiguous?: string } {
  const match = source.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/i);
  if (!match) return {};
  let hour = Number(match[1]), minute = Number(match[2] ?? 0);
  if (minute > 59 || hour > 23 || hour < 0) return {};
  const period = match[3]?.toLowerCase().replace(/\./g, '');
  if (!period && hour >= 1 && hour <= 12) return { ambiguous: `Is ${hour}:${String(minute).padStart(2, '0')} AM or PM? Choose the exact time in the review before continuing.` };
  if (period) {
    if (hour < 1 || hour > 12) return {};
    hour = hour % 12 + (period === 'pm' ? 12 : 0);
  }
  return { hour, minute };
}

function durationMs(source: string): number | undefined {
  const minutes = source.match(/\bfor\s+(\d{1,3})\s+minutes?\b/i)?.[1];
  if (minutes) return Number(minutes) * 60_000;
  const hours = source.match(/\bfor\s+(?:(\d+(?:\.\d+)?)|(?:an?|one))\s+hours?\b/i);
  if (hours) return Number(hours[1] || 1) * 3_600_000;
  return undefined;
}

function relativeRange(source: string, context: CalendarParseContext): { start?: string; end?: string; timeZone?: string; needsClarification?: string } {
  const now = context.now ?? Date.now(), fallback = context.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeZone = requestedZone(source, fallback), date = relativeDate(source, now, timeZone);
  if (!date) return {};
  const time = clock(source);
  if (time.ambiguous) return { timeZone, needsClarification: time.ambiguous };
  if (time.hour === undefined || time.minute === undefined) {
    const start = wallInstant(date, 0, 0, timeZone), end = wallInstant(addDays(date, 1), 0, 0, timeZone);
    return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), timeZone };
  }
  const start = wallInstant(date, time.hour, time.minute, timeZone), duration = durationMs(source);
  return { start: new Date(start).toISOString(), ...(duration ? { end: new Date(start + duration).toISOString() } : {}), timeZone,
    ...(!duration ? { needsClarification: 'Choose an exact end time or duration in the review before continuing.' } : {}) };
}

/**
 * Recognize only an explicit calendar request. Ambiguous "connect Google"
 * requests stay in the conversation so the assistant can ask which service.
 * Exact dates and fields are always reviewed in the inline card before a grant
 * is created; this parser never turns prose directly into a provider write.
 */
export function parseCalendarChatRequest(source: string, context: CalendarParseContext = {}): CalendarChatRequest | null {
  const text = source.trim();
  if (!text || text.length > 15_000 || unsafeControls.test(text) || !explicitCalendar.test(text)) return null;
  const exactDates = range(text), relativeDates = exactDates.start || exactDates.end ? {} : relativeRange(text, context);
  const dates = { ...exactDates, ...relativeDates }, id = eventId(text);
  if (/\b(?:delete|remove|cancel)\b/i.test(text)) return { kind: 'google-calendar', mode: 'delete', ...(id ? { eventId: id } : {}) };
  if (/\b(?:update|edit|change|move|reschedule|rename)\b/i.test(text)) return { kind: 'google-calendar', mode: 'update', ...(id ? { eventId: id } : {}), ...(title(text) ? { summary: title(text) } : {}), ...dates };
  if (/\b(?:create|add|schedule|make|put)\b/i.test(text)) return { kind: 'google-calendar', mode: 'create', ...(title(text) ? { summary: title(text) } : {}), ...dates };
  if (/\b(?:show|read|check|list|find|search|what(?:'s|\s+is)|review)\b/i.test(text)) return { kind: 'google-calendar', mode: 'read', ...dates };
  return null;
}

export function calendarRequestUuid(seed: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(`crokodial-calendar:${seed}`)).then(buffer => {
    const bytes = new Uint8Array(buffer).slice(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  });
}
