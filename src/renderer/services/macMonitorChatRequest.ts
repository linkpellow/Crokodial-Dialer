export type MacMonitorChatRequest = {
  kind: 'monitor.manage';
  operation: 'start' | 'stop' | 'status';
  messages: boolean;
  whatsapp: boolean;
  whatsappQuery: string;
  keywords: string[];
  intervalMinutes: number;
};

const CONTROL = /[\u0000-\u001f\u007f]/;

function clean(value: string, maximum: number): string {
  const candidate = value.replace(/^[\s"'“”‘’:,;—-]+|[\s"'“”‘’.,!?;]+$/g, '').replace(/\s+/g, ' ').trim();
  return candidate && candidate.length <= maximum && !CONTROL.test(candidate) ? candidate : '';
}

function uniqueKeywords(values: readonly string[]): string[] {
  const output: string[] = [], seen = new Set<string>();
  for (const value of values) {
    const keyword = clean(value, 64).toLowerCase();
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword); output.push(keyword);
    if (output.length === 20) break;
  }
  return output;
}

function explicitKeywords(source: string): string[] {
  const quoted = [...source.matchAll(/["“]([^"”]{1,64})["”]/g)].map(match => match[1]);
  const labeled = source.match(/\b(?:keywords?|phrases?|words?)\s*(?:are|include|including|:|=)?\s*([^.;\n]{1,400}?)(?=\s+every\s+\d{1,2}\s+minutes?\b|[.;\n]|$)/i)?.[1];
  if (labeled) return uniqueKeywords(labeled.split(/\s*,\s*|\s+and\s+/i));
  return uniqueKeywords(quoted);
}

function whatsappQuery(source: string): string {
  const match = source.match(/\bwhats\s*app\b\s*(?:conversation|thread|chat)?\s+(?:with|named|for)\s+(.+?)(?=\s+(?:every|using|with)\s+(?:the\s+)?(?:keywords?|phrases?|words?|\d+\s+minutes?)\b|[.;\n]|$)/i);
  if (match) return clean(match[1], 100);
  const quoted = source.match(/\bwhats\s*app\b\s*(?:conversation|thread|chat)?\s+(?:with|named|for)?\s*["“]([^"”]{2,100})["”]/i)?.[1];
  return clean(quoted ?? '', 100);
}

/**
 * Recognizes explicit management of the local, read-only Mac monitor. It does
 * not perform a read or change settings; the saved turn reconstructs a review
 * card where the owner selects exact sources and presses start or stop.
 */
export function parseMacMonitorChatRequest(value: string): MacMonitorChatRequest | null {
  const source = value.trim();
  if (!source || source.length > 15_000 || CONTROL.test(source)) return null;
  const surface = /\b(?:apple\s+messages|imessages?|whats\s*app|local\s+(?:messages?|communications?)|mac\s+(?:messages?|monitor))\b/i.test(source);
  const monitor = /\b(?:monitor(?:ing)?|watch|track|keep\s+an?\s+eye\s+on|check\s+(?:them\s+)?periodically|local\s+read\s+monitor)\b/i.test(source);
  if (!surface || !monitor || /\b(?:gmail|email|mailbox|inbox)\b/i.test(source)) return null;

  const stop = /\b(?:stop|pause|disable|turn\s+off|cancel|clear)\b/i.test(source);
  const status = !stop && /\b(?:status|state|is\s+(?:it|the\s+monitor)\s+(?:active|running|on)|show|inspect|check)\b/i.test(source)
    && !/\b(?:start|enable|turn\s+on|set\s+up|begin|watch|monitor)\b/i.test(source.replace(/\bmonitor(?:ing)?\b/ig, ''));
  const interval = Number(source.match(/\bevery\s+(\d{1,2})\s+minutes?\b/i)?.[1] ?? 5);
  if (!Number.isInteger(interval) || interval < 1 || interval > 30) return null;
  const messages = /\b(?:apple\s+messages|imessages?|local\s+messages?|mac\s+messages?)\b/i.test(source);
  const whatsapp = /\bwhats\s*app\b/i.test(source);
  return {
    kind: 'monitor.manage', operation: stop ? 'stop' : status ? 'status' : 'start',
    messages: messages || !whatsapp, whatsapp, whatsappQuery: whatsappQuery(source),
    keywords: explicitKeywords(source), intervalMinutes: interval,
  };
}
