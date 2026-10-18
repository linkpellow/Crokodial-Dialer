import type { MacContact, MacMessageThread, WhatsAppObservation } from './macConnectorTypes';

export type MacChatRequest =
  | { kind: 'messages.read'; query: string }
  | { kind: 'whatsapp.read'; query: string }
  | { kind: 'contacts.search'; query: string; unknownNumber: boolean }
  | { kind: 'messages.send'; target: string; text: string; phone?: string }
  | { kind: 'sms.compose'; phone: string; text: string };

export type MacChatReadResult =
  | { kind: 'messages.read' | 'messages.send'; threads: MacMessageThread[] }
  | { kind: 'whatsapp.read'; observations: WhatsAppObservation[]; observedAt: number }
  | { kind: 'contacts.search'; contacts: MacContact[] };

export interface MacChatReadService {
  listMessageThreads(query?: string): Promise<{ threads: MacMessageThread[] }>;
  searchWhatsApp(query: string): Promise<{ observations: WhatsAppObservation[] }>;
  searchContacts(query: string): Promise<{ contacts: MacContact[] }>;
}

const PHONE_PATTERN = /^\+?[0-9().\-\s]{7,40}$/;

function clean(value: string, max: number): string {
  return value
    .replace(/^[\s"'“”‘’:,—-]+|[\s"'“”‘’.,!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function exactText(value: string): string {
  const candidate = value.trim();
  if (!candidate || candidate.length > 4_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(candidate)) return '';
  return candidate;
}

function phone(value: string): string | undefined {
  const candidate = clean(value, 40);
  const digits = candidate.replace(/\D/g, '');
  return PHONE_PATTERN.test(candidate) && digits.length >= 7 && digits.length <= 15 ? candidate : undefined;
}

function quoted(value: string): string | undefined {
  const match = value.match(/["“]([^"”]{2,100})["”]/);
  return match ? clean(match[1], 100) : undefined;
}

function trailingQuery(value: string, marker: RegExp): string {
  const match = value.match(marker);
  return clean(match?.[1] ?? '', 100);
}

function parseExactSend(source: string): MacChatRequest | null {
  const compose = source.match(/^(?:please\s+)?(?:open|prepare|create|draft)\s+(?:an?\s+)?(?:unsent\s+)?(?:sms|text)(?:\s+message)?(?:\s+draft)?\s+(?:to|for)\s+(.+?)\s+(?:saying|that says|with(?:\s+the)?(?:\s+text|\s+message)?|:)\s+([\s\S]+)$/i);
  if (compose) {
    const recipient = phone(compose[1]);
    const text = exactText(compose[2]);
    return recipient && text ? { kind: 'sms.compose', phone: recipient, text } : null;
  }

  const patterns = [
    /^(?:please\s+)?(?:send\s+(?:an?\s+)?(?:imessage|sms|text|message)\s+to|text|message|imessage)\s+(.+?)\s+(?:saying|that says|with(?:\s+the)?(?:\s+text|\s+message)?)\s+([\s\S]+)$/i,
    /^(?:please\s+)?(?:send\s+(?:an?\s+)?(?:imessage|sms|text|message)\s+to|text|message|imessage)\s+([^:\n—]+?)\s*[:—]\s*([\s\S]+)$/i,
    /^(?:please\s+)?send\s+(.+?)\s+(?:an?\s+)?(?:imessage|sms|text|message)\s+(?:saying\s+)?([\s\S]+)$/i,
    /^(?:please\s+)?reply\s+(?:to\s+)?(.+?)\s+(?:in|using|via)\s+(?:apple\s+)?messages\s*[:,—-]?\s*([\s\S]+)$/i,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match) continue;
    const target = clean(match[1], 100), text = exactText(match[2]);
    if (target.length < 2 || !text) return null;
    const recipient = phone(target);
    return { kind: 'messages.send', target, text, ...(recipient ? { phone: recipient } : {}) };
  }
  return null;
}

/**
 * Recognize only explicit local-app requests. The result is reconstructed from a
 * persisted user turn; parsing never reads local data or performs an action.
 */
export function parseMacChatRequest(value: string): MacChatRequest | null {
  const source = value.trim().slice(0, 15_000);
  if (!source) return null;

  const send = parseExactSend(source);
  if (send) return send;

  if (/\bwhats\s*app\b/i.test(source) && /\b(?:find|search|look\s*up|check|read|show|scan)\b/i.test(source)) {
    const query = quoted(source)
      ?? trailingQuery(source, /\bwhats\s*app\b[\s,:-]*(?:messages?\s*)?(?:for|from|with|about|matching|containing)?\s*([\s\S]*)$/i)
      ?? '';
    return query.length >= 2 ? { kind: 'whatsapp.read', query } : null;
  }

  const unknownNumber = source.match(/\b(?:who(?:se)?(?:\s+is)?|identify|match|look\s*up|find)\b[\s\S]{0,40}?((?:\+?[0-9][0-9().\-\s]{5,38}[0-9]))/i);
  if (unknownNumber) {
    const query = phone(unknownNumber[1]);
    if (query) return { kind: 'contacts.search', query, unknownNumber: true };
  }

  const explicitLocalContacts = /\b(?:(?:mac|apple|icloud|local|my)\s+(?:contacts?|address\s+book)|(?:contacts?|address\s+book)\s+(?:on|in|from)\s+(?:my\s+)?(?:mac|icloud)|my\s+contact\b)/i.test(source);
  if (/\b(?:contacts?|address\s+book)\b/i.test(source)
    && /\b(?:find|search|look\s*up|check|match|identify|show)\b/i.test(source)
    && explicitLocalContacts) {
    const query = (quoted(source)
      ?? trailingQuery(source, /\b(?:contacts?|address\s+book)\b[\s,:-]*(?:for|named|matching|with)?\s*([\s\S]*)$/i))
      || trailingQuery(source, /\b(?:find|search|look\s*up|check|match|identify|show)\b\s+(.+?)\s+(?:in|using|from)\s+(?:(?:my|the)\s+)?(?:mac|apple|icloud|local)?\s*(?:contacts?|address\s+book)\b/i);
    return query.length >= 2 ? { kind: 'contacts.search', query, unknownNumber: Boolean(phone(query)) } : null;
  }

  const whatDid = source.match(/\bwhat\s+did\s+(.+?)\s+(?:say|send|text|message)(?:\s+me)?\b/i);
  const explicitMessagesApp = /\b(?:apple\s+messages|imessages?|my\s+(?:messages|texts?|text\s+messages?)|texts?|text\s+messages?)\b/i.test(source) || /\bMessages\b/.test(source);
  if (explicitMessagesApp
    && (/\b(?:find|search|look\s*up|check|read|show|open)\b/i.test(source) || Boolean(whatDid))
    && !/\b(?:email|gmail)\b/i.test(source)) {
    const query = (quoted(source)
      ?? (whatDid ? clean(whatDid[1], 100) : undefined)
      ?? trailingQuery(source, /\b(?:with|from|for|by)\b\s+([\s\S]+)$/i))
      || '';
    return { kind: 'messages.read', query };
  }

  return null;
}

export async function runMacChatRead(request: Exclude<MacChatRequest, { kind: 'sms.compose' }>, service: MacChatReadService): Promise<MacChatReadResult> {
  if (request.kind === 'contacts.search') {
    const { contacts } = await service.searchContacts(request.query);
    return { kind: request.kind, contacts: contacts.slice(0, 100) };
  }
  if (request.kind === 'whatsapp.read') {
    const { observations } = await service.searchWhatsApp(request.query);
    return { kind: request.kind, observations: observations.slice(0, 100), observedAt: Date.now() };
  }
  const { threads } = await service.listMessageThreads(request.kind === 'messages.send' ? request.target : request.query);
  return { kind: request.kind, threads: threads.slice(0, 50) };
}
