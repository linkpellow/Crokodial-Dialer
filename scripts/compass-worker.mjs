// Reuse the verified Quotes Compass modules in a private child process. No HTTP listener.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const source = process.env.CROKODIAL_COMPASS_SOURCE;
if (!source) throw new Error('Quotes Compass source is not configured.');
const from = relative => import(pathToFileURL(path.join(source, relative)).href);
const ready = (async () => {
  // Reuse source configuration in this private process; never return or package its .env.
  (await from('src/load-env.js')).loadEnv();
  // Respect explicit user/source settings. Otherwise prefer a verified installed
  // small model; this is a read-only discovery and never pulls a model.
  if (!process.env.OLLAMA_FAST_MODEL && !process.env.OLLAMA_MODEL) {
    try {
      const host = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
      const response = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
      const tags = response.ok ? await response.json() : {};
      const available = new Set((tags.models || []).map(model => model.name));
      const preferred = ['qwen3.5:4b-q4_K_M', 'qwen2.5:7b', 'qwen2.5:14b'].find(model => available.has(model));
      if (preferred) {
        process.env.OLLAMA_FAST_MODEL = preferred;
        if (!process.env.OLLAMA_QUALITY_MODEL && !process.env.OLLAMA_ESCALATION_MODEL) process.env.OLLAMA_QUALITY_MODEL = preferred;
        if (preferred.startsWith('qwen3.5:')) {
          // The preserved source stream parser predates reasoning models and only
          // consumes visible content. Adapt our automatic default, leaving explicit
          // user model settings and every non-Ollama request unchanged.
          const originalFetch = globalThis.fetch;
          globalThis.fetch = (input, options) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            if (url === `${host}/api/chat` && typeof options?.body === 'string') {
              try {
                const body = JSON.parse(options.body);
                if (body.model === preferred && body.think === undefined) {
                  return originalFetch(input, { ...options, body: JSON.stringify({ ...body, think: false }) });
                }
              } catch { /* Non-JSON calls retain their original behavior. */ }
            }
            return originalFetch(input, options);
          };
        }
      }
    } catch { /* Deterministic insurance tools remain available while Ollama is offline. */ }
  }
  const modules = await Promise.all([from('src/plans.js'), from('src/assistant/orchestrator.js')]);
  (await from('src/assistant/pdf-search.js')).buildBrochureIndex();
  (await from('src/formulary.js')).preloadFormularyDrugIndices();
  return modules;
})();
// Keep initialization rejection available to the request handler without an unhandled exit.
void ready.catch(() => {});
process.on('message', async ({ id, operation, payload }) => {
  try {
    const [catalog, assistant] = await ready;
    let data;
    if (operation === 'plans') data = catalog.listPlans({ quotableOnly: false }).map(({ id, name, carrier }) => ({ id, name, carrier }));
    else if (operation === 'brochure') data = (await from('src/plan-brochures.js')).resolveBrochureOpenTarget(payload?.planId);
    else if (operation === 'chat') {
      const message = typeof payload?.message === 'string' ? payload.message.trim() : '';
      if (!message || message.length > 16000) throw new Error('Enter a message up to 16,000 characters.');
      if (payload.planId && !catalog.getPlan(payload.planId)) throw new Error('The selected product is no longer in Quotes Compass.');
      const householdModule = await from('src/assistant/household.js');
      const household = householdModule.parseHouseholdFromText(message);
      const simple = householdModule.parseSimpleQuoteRequest(message);
      const householdRequested = household.members.length > 1 || household.tier !== 'employee' || (simple.tier && simple.tier !== 'employee') || /\b(family|spouse|children|dependents|wife|husband)\b/i.test(message);
      const resolvedId = (await from('src/assistant/plan-resolve.js')).resolvePlanIdFromMessage(message, payload.planId);
      const unsupportedHousehold = () => new Error('Golden Rule source pricing is individual-only. A verified household quote is unavailable; select employee-only coverage or use the carrier enrollment quote.');
      if (householdRequested && catalog.getPlan(resolvedId)?.quoteEngine === 'golden_rule') throw unsupportedHousehold();
      // The original orchestrator preserves quote, benefits, formulary and brochure
      // tools, conversation state and its deterministic fast path before model access.
      data = await assistant.runAssistantChat({ message, planId: payload.planId || null, conversationId: payload.conversationId });
      // Catch implicitly resolved Golden Rule products in household requests as well.
      if (householdRequested && /premium|quote|cost|price|compare|monthly/i.test(message)) {
        const used = JSON.stringify(data.toolCalls ?? []);
        if (catalog.plans.some(plan => plan.quoteEngine === 'golden_rule' && used.includes(plan.id))) throw unsupportedHousehold();
      }
    } else throw new Error('Unknown insurance operation.');
    process.send?.({ id, data });
  } catch (error) { process.send?.({ id, error: error instanceof Error ? error.message : 'Insurance research failed.' }); }
});
process.on('disconnect', () => process.exit(0));
