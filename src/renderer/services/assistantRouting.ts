import type { InsurancePlan } from './assistantApiService';

export interface CatalogProduct { id: string; name: string; carrier?: string }
export interface ConversationTurn { role: 'user' | 'assistant'; text: string }
export interface ResearchContext { query: string }
export interface QuoteInputs { age: number; tier: 'employee' | 'employee_spouse' | 'employee_children' | 'employee_family'; state?: string }
export type AssistantRoute =
  | { kind: 'platform' }
  | { kind: 'clarify'; reply: string; context: ResearchContext }
  | { kind: 'compass'; message: string; planId?: string; planIds?: string[]; quoteInputs: QuoteInputs; context: ResearchContext };

const positiveMentions = (text: string) => text.replace(/\b(?:not|exclude|except|without|instead of)\s+[^,;.!?\n]+?(?=\b(?:but|instead|rather|and|for|age)\b|[,;.!?\n]|$)/gi, ' ');
const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const mentions = (text: string, alias: string) => {
  const normalized = normalize(alias);
  text = positiveMentions(text);
  if (normalized.length < 4) return false;
  const haystack = ` ${normalize(text)} `;
  return haystack.includes(` ${normalized} `) || haystack.includes(` ${normalized.replace(/\s/g, '')} `);
};
const supportOrBenefits = /\b(email|draft|support|missing|id cards?|billing issue|refund|cancel|deductible|copay|coinsurance|out.of.pocket|benefits?|specialist|emergency|visits?|formulary|medications?|prescription|available|availability|states?|network)\b/i;
const priceIntent = /\b(quote|quotes|premium|premiums|pricing|cheaper|cheapest|affordable|monthly rate|monthly cost|monthly price|least expensive|lowest price)\b/i;
const alternativeIntent = /\b(cheaper|cheapest|affordable|alternative|least expensive|lowest price)\b/i;
const states = 'AL:Alabama|AK:Alaska|AZ:Arizona|AR:Arkansas|CA:California|CO:Colorado|CT:Connecticut|DE:Delaware|DC:District of Columbia|FL:Florida|GA:Georgia|HI:Hawaii|ID:Idaho|IL:Illinois|IN:Indiana|IA:Iowa|KS:Kansas|KY:Kentucky|LA:Louisiana|ME:Maine|MD:Maryland|MA:Massachusetts|MI:Michigan|MN:Minnesota|MS:Mississippi|MO:Missouri|MT:Montana|NE:Nebraska|NV:Nevada|NH:New Hampshire|NJ:New Jersey|NM:New Mexico|NY:New York|NC:North Carolina|ND:North Dakota|OH:Ohio|OK:Oklahoma|OR:Oregon|PA:Pennsylvania|RI:Rhode Island|SC:South Carolina|SD:South Dakota|TN:Tennessee|TX:Texas|UT:Utah|VT:Vermont|VA:Virginia|WA:Washington|WV:West Virginia|WI:Wisconsin|WY:Wyoming'.split('|').map(item => item.split(':'));
function lastState(text: string) {
  let best: { index: number; code: string } | undefined;
  for (const [code, name] of states) {
    const names = [...text.matchAll(new RegExp(`\\b${name}\\b`, 'gi'))];
    const codes = [...text.matchAll(new RegExp(`\\b${code}\\b`, 'g'))];
    for (const match of [...names, ...codes]) if (!best || match.index! > best.index) best = { index: match.index!, code };
  }
  return best?.code;
}
const quoteFollowUp = /^(?:(?:what|how) about\b|and\b|for\b|age\b|\d|employee\b|family\b|spouse\b|wife\b|husband\b|children\b|dependents\b|just\b|only\b|florida\b|texas\b|california\b|new york\b)/i;

function productMatches(text: string, products: CatalogProduct[]) {
  const found = products.filter(product => mentions(text, product.id) || mentions(text, product.name));
  // A shorter name such as “HSA 3500” must not select a different product when
  // the user explicitly named “LIFEX HSA 3500”. Keep equally specific collisions
  // for clarification instead of silently picking the first catalog row.
  return found.filter(product => mentions(text, product.id) || !found.some(other => other.id !== product.id && normalize(other.name).length > normalize(product.name).length && normalize(other.name).includes(normalize(product.name))));
}
function namedFamilies(text: string, families: InsurancePlan[], products: CatalogProduct[]) {
  return families.filter(family => mentions(text, family.id) || mentions(text, family.name)
    || products.some(product => family.variants.some(variant => variant.id === product.id) && product.carrier && mentions(text, product.carrier)));
}

function unresolvedPlanWords(message: string): string {
  let text = positiveMentions(message);
  for (const [code, name] of states) text = text.replace(new RegExp(`\\b${name}\\b`, 'gi'), ' ').replace(new RegExp(`\\b${code}\\b`, 'g'), ' ');
  return normalize(text).replace(/\b(?:what|what s|s|about|is|are|was|would|will|can|could|should|does|do|how|much|please|help|me|my|us|our|his|her|him|them|their|your|a|an|the|for|on|of|at|in|and|or|with|without|only|just|this|that|these|those|it|same|one|ones|plan|plans|product|products|provider|carrier|quote|quotes|premium|premiums|monthly|annual|rate|rates|price|prices|pricing|cost|payment|amount|instead|now|again|new|another|different|next|state|client|customer|person|applicant|member|age|ages|aged|year|years|old|yo|employee|individual|spouse|wife|husband|family|children|dependents|coverage|insurance|health|medical|cheaper|cheapest|affordable|alternative|alternatives|find|compare|comparison|best|least|expensive|lowest|option|options|ppo|hsa|epo|hdhp|budget|under|up|to|less|than|no|not|but|male|female)\b|\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Routing only chooses a capability. It never supplies policy facts or rates. */
export function routeAssistantRequest(input: {
  message: string; history: ConversationTurn[]; families: InsurancePlan[];
  products: CatalogProduct[]; research?: ResearchContext;
}): AssistantRoute {
  const { message, history, products, research } = input;
  const families = [...input.families];
  for (const carrier of new Set(products.map(product => product.carrier).filter((value): value is string => Boolean(value)))) {
    const carrierProducts = products.filter(product => product.carrier === carrier);
    if (!families.some(family => family.variants.some(variant => carrierProducts.some(product => product.id === variant.id)))) families.push({ id: carrier, name: carrier.replace(/_/g, ' '), variants: carrierProducts });
  }
  const currentProducts = productMatches(message, products);
  const currentFamilies = namedFamilies(message, families, products);
  const compoundBenefits = /\b(?:benefits?|coverage|deductibles?|copays?|specialist|emergency|visits?|formulary|prescriptions?|networks?)\b/i.test(message) && /\b(?:and|also|plus|as well)\b/i.test(message);
  const hasPrice = priceIntent.test(message) && !compoundBenefits && !/\b(?:support|email|draft|missing|billing issue|refund|cancel)\b/i.test(message);
  const isStateAnswer = Boolean(lastState(message) && !/\b(?:what|which|where|available|availability|coverage|benefits?|network)\b/i.test(message));
  const isFollowUp = Boolean(research && (!supportOrBenefits.test(message) || isStateAnswer) && (quoteFollowUp.test(message) || Boolean(lastState(message)) || currentProducts.length || currentFamilies.length));
  if (!hasPrice && !isFollowUp) return { kind: 'platform' };

  const unknownTarget = !currentProducts.length && !currentFamilies.length
    ? /\b(?:quote|premiums? (?:for|on)|prices? (?:for|on))\s+(?!for\b|this\b|that\b|it\b|these\b|those\b|the plan\b|age\b|a (?:new |different )?client\b)([a-z][a-z0-9 _+-]*?)(?=\s+(?:for|at|in|age|employee|instead)\b|[?.!]|$)/i.exec(positiveMentions(message))?.[1]?.trim()
    : undefined;
  const query = isFollowUp && !hasPrice ? `${research!.query}\nFollow-up: ${message}` : message;
  const context = { query: query.slice(-12000) };
  const unresolvedTarget = unknownTarget || (!currentProducts.length && !currentFamilies.length ? unresolvedPlanWords(message) : '');
  if (unresolvedTarget && !/^(?:me|us|him|her|them|please|options?|plans?|alternatives?)$/i.test(unresolvedTarget)) return { kind: 'clarify', context, reply: `I couldn’t match “${unresolvedTarget}” to a verified quote source. Which provider or plan variation do you mean?` };
  if (!currentProducts.length && !currentFamilies.length && /\b(?:not|exclude|except|instead of)\b/i.test(message) && !alternativeIntent.test(message)) return { kind: 'clarify', context, reply: 'Which provider or plan variation should I quote instead?' };
  let matchedProducts = currentProducts;
  let matchedFamilies = currentFamilies;
  if (!matchedProducts.length && !matchedFamilies.length && !alternativeIntent.test(query)) {
    for (const turn of [...history].reverse()) {
      if (turn.role !== 'user') continue;
      matchedProducts = productMatches(turn.text, products);
      matchedFamilies = namedFamilies(turn.text, families, products);
      if (matchedProducts.length || matchedFamilies.length) break;
      // An explicit unrelated task ends implicit plan inheritance.
      if (/\b(draft|email|schedule|appointment|remind)\b/i.test(turn.text)) break;
    }
  }
  const comparingProducts = /\b(compare|both|versus|vs)\b/i.test(query) || (/\band\b/i.test(query) && new Set(matchedProducts.map(product => normalize(product.name))).size > 1);
  if (matchedFamilies.length) {
    const allowed = new Set(matchedFamilies.flatMap(family => family.variants.map(variant => variant.id)));
    if (matchedProducts.length && !comparingProducts) matchedProducts = matchedProducts.filter(product => allowed.has(product.id));
    if (!matchedProducts.length && !alternativeIntent.test(query)) {
      const choices = matchedFamilies.flatMap(family => family.variants.map(variant => ({ family, variant })))
        .filter(({ variant }) => products.some(product => product.id === variant.id));
      if (choices.length === 1) matchedProducts = products.filter(product => product.id === choices[0].variant.id);
      else return { kind: 'clarify', context, reply: choices.length
        ? `Which ${matchedFamilies.map(family => family.name).join(' or ')} variation should I quote? ${choices.slice(0, 8).map(({ variant }) => variant.name).join(', ')}${choices.length > 8 ? ', or another variation' : ''}. Rates differ by product.`
        : `I don’t have a verified Quotes Compass rate source for ${matchedFamilies.map(family => family.name).join(' and ')}. I can help with its plan documents, or you can use its configured enrollment portal for a current quote.` };
    }
  }
  // Multiple identical names from different providers are not a comparison.
  if (matchedProducts.length > 1 && !comparingProducts) return {
    kind: 'clarify', context,
    reply: `Which product do you mean: ${matchedProducts.slice(0, 6).map(product => `${product.name}${product.carrier ? ` (${product.carrier.replace(/_/g, ' ')})` : ''}`).join(', ')}?`,
  };
  const newClient = /\b(?:new|another|different|next)\s+(?:client|person|customer|applicant|member)\b/i;
  const scopedUsers: string[] = [];
  if (!newClient.test(message)) for (const turn of [...history].reverse()) {
    if (turn.role !== 'user') continue;
    const related = priceIntent.test(turn.text) || supportOrBenefits.test(turn.text) || /\b(?:plan|coverage|insurance|compare|age|employee|family|spouse|husband|wife|children|dependents)\b/i.test(turn.text) || /^\d/.test(turn.text) || Boolean(lastState(turn.text)) || productMatches(turn.text, products).length || namedFamilies(turn.text, families, products).length;
    if (!related || /\b(?:draft|email|schedule|appointment|remind)\b/i.test(turn.text)) break;
    scopedUsers.unshift(turn.text);
    if (newClient.test(turn.text) || scopedUsers.length >= 8) break;
  }
  const facts = `${scopedUsers.join('\n')}\n${message}`;
  const ages = [...facts.matchAll(/\b(?:age[ds]?\s*[:=]?\s*)(\d{1,3})\b|\b(\d{1,3})\s*(?:year[ -]?old|years? old|yo)\b|(?:^|\n|Follow-up:\s*)(\d{1,3})(?:\s*[,;]|\s+(?:employee|male|female|florida|texas|california))/gi)];
  const lastAge = ages.at(-1);
  const bareAges = [...facts.matchAll(/(?:^|\n)\s*(\d{1,3})\s*(?=\n|$)/g)];
  const lastBareAge = bareAges.at(-1);
  const age = lastBareAge && (!lastAge || lastBareAge.index! > lastAge.index!) ? lastBareAge[1] : lastAge?.[1] ?? lastAge?.[2] ?? lastAge?.[3];
  if (!age || Number(age) > 120) return { kind: 'clarify', context, reply: 'What age should I use for the quote, and is coverage for the employee only, a spouse, or a family? Include the state so I can check availability.' };
  const tierText = [...facts.split('\n')].reverse().find(line => /\b(family|children|dependents|spouse|wife|husband|employee|individual|just (?:me|him|her)|only (?:me|him|her))\b/i.test(line)) ?? '';
  const tier = /\bfamily\b/i.test(tierText) ? 'family'
    : /\b(?:children|dependents)\b/i.test(tierText) ? (/\b(?:spouse|wife|husband)\b/i.test(tierText) ? 'family' : 'employee and children')
    : /\b(?:spouse|wife|husband)\b/i.test(tierText) ? 'employee and spouse'
    : /\b(?:employee|just (?:me|him|her)|only (?:me|him|her)|individual)\b/i.test(tierText) ? 'employee' : undefined;
  if (!tier) return { kind: 'clarify', context, reply: `For age ${age}, is coverage for the employee only, an employee and spouse, or a family?` };
  const ids = [...new Set(matchedProducts.map(product => product.id))];
  // Only the current request reaches Compass's demographic parser. Replaying
  // older quotes here would turn age corrections into extra household members.
  const currentHasAge = /\bage[ds]?\s*[:=]?\s*\d{1,3}\b|\b\d{1,3}\s*(?:year[ -]?old|years? old|yo)\b|^\d{1,3}(?:\s*[,;]|\s+(?:employee|male|female|florida|texas|california))/i.test(message);
  const currentHasTier = /\b(?:family|children|dependents|spouse|wife|husband|employee|individual|just (?:me|him|her)|only (?:me|him|her))\b/i.test(message);
  const engineQuestion = hasPrice ? message : `${alternativeIntent.test(query) ? 'Find cheaper plan alternatives' : 'Monthly premium quote'}. ${message}`;
  const contextText = `${currentHasAge ? '' : `\nApplicant age ${age}.`}${currentHasTier ? '' : `\nCoverage: ${tier}.`}`;
  const quoteInputs: QuoteInputs = { age: Number(age), tier: tier === 'family' ? 'employee_family' : tier === 'employee and spouse' ? 'employee_spouse' : tier === 'employee and children' ? 'employee_children' : 'employee', ...(lastState(facts) ? { state: lastState(facts) } : {}) };
  return { kind: 'compass', context, quoteInputs, message: (engineQuestion + contextText).slice(0, 16000),
    ...(ids.length === 1 ? { planId: ids[0] } : ids.length > 1 ? { planIds: ids } : {}) };
}

export function conversationPlanHistory(turns: ConversationTurn[]): string[] {
  return turns.filter(turn => turn.role === 'user').slice(-12).map(turn => turn.text.slice(0, 2000));
}
