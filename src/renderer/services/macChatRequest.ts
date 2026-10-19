import type { MacContact, MacContactChange, MacMessageThread, WhatsAppObservation } from './macConnectorTypes';

type MacContactCreate = Extract<MacContactChange, { operation: 'create' }>;
type MacContactUpdateChanges = Extract<MacContactChange, { operation: 'update' }>['changes'];

export type MacChatRequest =
  | { kind: 'messages.read'; query: string }
  | { kind: 'whatsapp.read'; query: string }
  | { kind: 'contacts.search'; query: string; unknownNumber: boolean }
  | { kind: 'contacts.create'; query: string; change: MacContactCreate }
  | { kind: 'contacts.update'; query: string; changes: MacContactUpdateChanges }
  | { kind: 'messages.send'; target: string; text: string; phone?: string }
  | { kind: 'sms.compose'; phone: string; text: string };

export type MacChatReadResult =
  | { kind: 'messages.read' | 'messages.send'; threads: MacMessageThread[] }
  | { kind: 'whatsapp.read'; observations: WhatsAppObservation[]; observedAt: number }
  | { kind: 'contacts.search' | 'contacts.create' | 'contacts.update'; contacts: MacContact[] };

export interface MacChatReadService {
  listMessageThreads(query?: string): Promise<{ threads: MacMessageThread[] }>;
  searchWhatsApp(query: string): Promise<{ observations: WhatsAppObservation[] }>;
  searchContacts(query: string): Promise<{ contacts: MacContact[] }>;
}

const PHONE_PATTERN = /^\+?[0-9().\-\s]{7,40}$/;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const LOCAL_CONTACTS = '(?:(?:my|the)\\s+)?(?:mac|apple|icloud|local)\\s+(?:contacts?|address\\s+book)';

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
  // Generic “text”, “SMS”, and “send a message” requests belong to the
  // server-owned CRM/Telnyx workflow. A saved turn gets a native write card
  // only when it names Apple's local Messages surface unambiguously.
  const compose = source.match(/^(?:please\s+)?(?:open|prepare|create|draft)\s+(?:an?\s+)?(?:unsent\s+)?(?:apple|mac|system)\s+messages\s+(?:compose|draft)\s+(?:on\s+(?:this|my)\s+mac\s+)?(?:to|for)\s+(.+?)\s+(?:saying|that says|with(?:\s+the)?(?:\s+text|\s+message)?|:)\s+([\s\S]+)$/i);
  if (compose) {
    const recipient = phone(compose[1]);
    const text = exactText(compose[2]);
    return recipient && text ? { kind: 'sms.compose', phone: recipient, text } : null;
  }

  const patterns = [
    /^(?:please\s+)?(?:send\s+(?:an?\s+)?imessage\s+to|imessage)\s+(.+?)\s+(?:saying|that says|with(?:\s+the)?(?:\s+text|\s+message)?)\s+([\s\S]+)$/i,
    /^(?:please\s+)?(?:send\s+(?:an?\s+)?imessage\s+to|imessage)\s+([^:\n—]+?)\s*[:—]\s*([\s\S]+)$/i,
    /^(?:please\s+)?reply\s+(?:to\s+)?(.+?)\s+(?:in|using|via)\s+(?:apple\s+)?messages\s*[:,—-]?\s*([\s\S]+)$/i,
    /^(?:please\s+)?(?:use|open)\s+(?:the\s+)?(?:apple|mac)\s+messages\s+(?:app\s+)?to\s+reply\s+(?:to\s+)?(.+?)\s*[:,—-]\s*([\s\S]+)$/i,
    /^(?:please\s+)?in\s+(?:the\s+)?existing\s+(?:apple|mac)?\s*messages\s+(?:thread|conversation)\s+with\s+(.+?)\s*[:,—-]\s*(?:send|reply(?:\s+with)?)\s+([\s\S]+)$/i,
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

function exactField(value: string, max: number): string | undefined {
  const candidate = value.replace(/^[\s"'“”‘’:,—-]+|[\s"'“”‘’.,!?]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!candidate || candidate.length > max || /[\u0000-\u001f\u007f]/.test(candidate)) return undefined;
  return candidate;
}

function contactName(value: string): { firstName: string; lastName: string } | null {
  const name = exactField(value.replace(/^(?:an?\s+)?(?:new\s+)?contact\s+(?:named|for)\s+/i, ''), 200);
  if (!name) return null;
  const parts = name.split(' '), firstName = parts.shift() ?? '', lastName = parts.join(' ');
  return firstName.length <= 100 && lastName.length <= 100 ? { firstName, lastName } : null;
}

function labeledValue(details: string, label: string, max: number): string | undefined {
  const boundary = '(?=\\s*(?:[,;]|\\band\\b|\\b(?:first\\s+name|last\\s+name|organization|company|email(?:\\s+address)?|phone|mobile|cell)(?:\\s+number)?\\b|$))';
  const match = details.match(new RegExp(`\\b${label}\\b\\s*(?:(?:is|to|as)\\s+|[:=]\\s*)?(.+?)${boundary}`, 'i'));
  return match ? exactField(match[1], max) : undefined;
}

function contactFields(details: string, update: boolean): MacContactUpdateChanges | MacContactCreate['contact'] | null {
  const emails = [...details.matchAll(/\b(?:email(?:\s+address)?)\b\s*(?:(?:is|to|as)\s+|[:=]\s*)?([^\s,;]+@[^\s,;<>]+\.[^\s,;<>]+)/gi)]
    .map(match => match[1].replace(/[.!?]+$/, '').toLowerCase()).filter(value => EMAIL_PATTERN.test(value));
  const phones = [...details.matchAll(/\b(?:phone|mobile|cell)(?:\s+number)?\b\s*(?:(?:is|to|as)\s+|[:=]\s*)?(\+?[0-9][0-9().\-\s]{5,38}[0-9])/gi)]
    .map(match => phone(match[1])).filter((value): value is string => Boolean(value));
  const firstName = labeledValue(details, 'first\\s+name', 100);
  const lastName = labeledValue(details, 'last\\s+name', 100);
  const organization = labeledValue(details, '(?:organization|company)', 200);
  if (update) {
    const changes: MacContactUpdateChanges = {};
    if (firstName !== undefined) changes.firstName = firstName;
    if (lastName !== undefined) changes.lastName = lastName;
    if (organization !== undefined) changes.organization = organization;
    if (emails.length) changes.addEmails = [...new Set(emails)].slice(0, 10);
    if (phones.length) changes.addPhones = [...new Set(phones)].slice(0, 10);
    return Object.keys(changes).length ? changes : null;
  }
  return { firstName: firstName ?? '', lastName: lastName ?? '', ...(organization !== undefined ? { organization } : {}),
    emails: [...new Set(emails)].slice(0, 10), phones: [...new Set(phones)].slice(0, 10) };
}

function parseContactMutation(source: string): MacChatRequest | null {
  const local = new RegExp(LOCAL_CONTACTS, 'i');
  if (!local.test(source)) return null;

  const createPatterns = [
    new RegExp(`^(?:please\\s+)?(?:create|add|save)\\s+(?:an?\\s+)?(?:new\\s+)?(?:mac|apple|icloud|local)\\s+contact\\s+(?:named|for)\\s+(.+?)(?:\\s+(?:with|having)\\s+([\\s\\S]+))?$`, 'i'),
    new RegExp(`^(?:please\\s+)?(?:create|add|save)\\s+(.+?)\\s+(?:in|to)\\s+${LOCAL_CONTACTS}(?:\\s+(?:with|having)\\s+([\\s\\S]+))?$`, 'i'),
    new RegExp(`^(?:please\\s+)?(?:in|to)\\s+${LOCAL_CONTACTS}\\s*[,;:]?\\s*(?:create|add|save)\\s+(?:an?\\s+)?(?:new\\s+)?contact\\s+(?:named|for)\\s+(.+?)(?:\\s+(?:with|having)\\s+([\\s\\S]+))?$`, 'i'),
  ];
  for (const pattern of createPatterns) {
    const match = source.match(pattern);
    if (!match) continue;
    const name = contactName(match[1]), supplied = contactFields(match[2] ?? '', false) as MacContactCreate['contact'] | null;
    if (!name || !supplied) return null;
    const contact = { ...supplied, ...name };
    const query = contact.emails?.[0] ?? contact.phones?.[0] ?? [contact.firstName, contact.lastName].filter(Boolean).join(' ') ?? contact.organization;
    return query && query.length >= 2 ? { kind: 'contacts.create', query, change: { operation: 'create', contact } } : null;
  }

  const updatePatterns = [
    new RegExp(`^(?:please\\s+)?(?:update|edit|change)\\s+(.+?)\\s+(?:in|on)\\s+${LOCAL_CONTACTS}\\s*(?:with|:|—|-)\\s*([\\s\\S]+)$`, 'i'),
    new RegExp(`^(?:please\\s+)?(?:in|on)\\s+${LOCAL_CONTACTS}\\s*[,;:]?\\s*(?:update|edit|change)\\s+(.+?)\\s*(?:with|:|—|-)\\s*([\\s\\S]+)$`, 'i'),
    new RegExp(`^(?:please\\s+)?(?:update|edit|change)\\s+(?:the\\s+)?(?:mac|apple|icloud|local)\\s+contact\\s+(?:named|for)\\s+(.+?)\\s*(?:with|:|—|-)\\s*([\\s\\S]+)$`, 'i'),
  ];
  for (const pattern of updatePatterns) {
    const match = source.match(pattern);
    if (!match) continue;
    const query = exactField(match[1], 100), changes = contactFields(match[2], true) as MacContactUpdateChanges | null;
    return query && query.length >= 2 && changes ? { kind: 'contacts.update', query, changes } : null;
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

  const contactMutation = parseContactMutation(source);
  if (contactMutation) return contactMutation;

  if (/\bwhats\s*app\b/i.test(source) && /\b(?:find|search|look\s*up|check|read|show|scan)\b/i.test(source)) {
    const query = quoted(source)
      ?? trailingQuery(source, /\bwhats\s*app\b[\s,:-]*(?:messages?\s*)?(?:for|from|with|about|matching|containing)?\s*([\s\S]*)$/i)
      ?? '';
    return query.length >= 2 ? { kind: 'whatsapp.read', query } : null;
  }

  // Generic “my contacts” must retain an explicitly named Google source.
  // A named Mac/Apple/iCloud source still selects a local Contacts request.
  const namedLocalContacts = /\b(?:(?:mac|apple|icloud|local)\s+(?:contacts?|address\s+book)|(?:contacts?|address\s+book)\s+(?:on|in|from)\s+(?:my\s+)?(?:mac|icloud))\b/i.test(source);
  const googleContacts = /\bgoogle\s+contacts?\b/i.test(source);
  const explicitLocalContacts = namedLocalContacts || !googleContacts && /\bmy\s+(?:contacts?|address\s+book)\b/i.test(source);

  const unknownNumber = source.match(/\b(?:who(?:se)?(?:\s+is)?|identify|match|look\s*up|find)\b[\s\S]{0,40}?((?:\+?[0-9][0-9().\-\s]{5,38}[0-9]))/i);
  if (unknownNumber && (!googleContacts || namedLocalContacts)) {
    const query = phone(unknownNumber[1]);
    if (query) return { kind: 'contacts.search', query, unknownNumber: true };
  }

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
  if (request.kind === 'contacts.search' || request.kind === 'contacts.create' || request.kind === 'contacts.update') {
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
