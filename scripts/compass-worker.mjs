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
      const planIds = payload.planIds == null ? [] : payload.planIds;
      if (!Array.isArray(planIds) || planIds.length > 8 || planIds.some(id => typeof id !== 'string' || !catalog.getPlan(id))) throw new Error('One or more requested products are no longer in Quotes Compass.');
      // Import only bounded conversational memory. It is not tool evidence: the
      // original engine keeps verified tool digests separate from dialogue.
      const store = await from('src/assistant/conversation-store.js');
      if (payload.history !== undefined) {
        if (!Array.isArray(payload.history) || payload.history.length > 12 || payload.history.some(turn => !turn || !['user', 'assistant'].includes(turn.role) || typeof turn.text !== 'string' || turn.text.length > 2000)) throw new Error('Invalid conversation context.');
        if (payload.conversationId) store.updateSession(payload.conversationId, { history: payload.history.map(turn => ({ role: turn.role, text: turn.text.slice(0, 1200), at: Date.now() })) });
      }
      const householdModule = await from('src/assistant/household.js');
      const household = householdModule.parseHouseholdFromText(message);
      const simple = householdModule.parseSimpleQuoteRequest(message);
      const quoteInputs = payload.quoteInputs;
      if (quoteInputs !== undefined && (!quoteInputs || !Number.isInteger(quoteInputs.age) || quoteInputs.age < 0 || quoteInputs.age > 120 || !['employee', 'employee_spouse', 'employee_children', 'employee_family'].includes(quoteInputs.tier) || (quoteInputs.state !== undefined && !/^[A-Z]{2}$/.test(quoteInputs.state)))) throw new Error('Invalid quote inputs. Provide an age, coverage tier and state.');
      const householdRequested = (quoteInputs && quoteInputs.tier !== 'employee') || household.members.length > 1 || household.tier !== 'employee' || (simple.tier && simple.tier !== 'employee') || /\b(family|spouse|children|dependents|wife|husband)\b/i.test(message);
      const resolvedId = (await from('src/assistant/plan-resolve.js')).resolvePlanIdFromMessage(message, payload.planId);
      const unsupportedHousehold = () => new Error('Golden Rule source pricing is individual-only. A verified household quote is unavailable; select employee-only coverage or use the carrier enrollment quote.');
      if (householdRequested && [resolvedId, ...planIds].some(id => catalog.getPlan(id)?.quoteEngine === 'golden_rule')) throw unsupportedHousehold();
      // The original orchestrator preserves quote, benefits, formulary and brochure
      // tools, conversation state and its deterministic fast path before model access.
      if (quoteInputs !== undefined || planIds.length > 1) {
        const age = quoteInputs?.age ?? householdModule.extractAgeFromMessage(message, null);
        const tier = quoteInputs?.tier ?? simple.tier ?? household.tier;
        if (!Number.isFinite(age) || age < 0 || age > 120) throw new Error('Provide the applicant age before comparing premiums.');
        const { executeTool } = await from('src/assistant/tools.js');
        const toolCalls = [];
        const selectedIds = [...new Set([...(payload.planId ? [payload.planId] : []), ...planIds])];
        const state = quoteInputs?.state ?? household.state;
        if (selectedIds.length) {
          for (const planId of selectedIds) {
            const args = { planId, age, tier, ...(state ? { state } : {}) };
            toolCalls.push({ toolName: 'quote', args, result: await executeTool('quote', args) });
          }
        } else {
          const criteria = (await from('src/assistant/plan-criteria.js')).extractPlanCriteria(message);
          const args = { age, tier, ...(state ? { state } : {}), carriers: criteria.carriers, networks: criteria.networks,
            planTypes: criteria.planTypes, unknownCarriers: criteria.unknownCarriers, rankBy: criteria.rankBy ?? 'premium',
            ...(criteria.effectiveDrug ? { drug: criteria.effectiveDrug } : {}),
            ...(criteria.service?.code ? { serviceCode: criteria.service.code } : {}),
            ...(criteria.condition?.note ? { conditionNote: criteria.condition.note } : {}), limit: 5 };
          toolCalls.push({ toolName: 'find_plans', args, result: await executeTool('find_plans', args) });
        }
        const { formatPrepassReply } = await from('src/assistant/fast-replies.js');
        const formatted = toolCalls.map(tool => formatPrepassReply([tool]) ?? { reply: `${catalog.getPlan(tool.args.planId)?.name ?? 'Plan research'}: ${tool.result.message || 'A verified quote is unavailable.'}`, citations: [] });
        data = { reply: formatted.map(item => item.reply).join('\n\n'), citations: formatted.flatMap(item => item.citations), toolCalls };
        store.appendConversationTurn(payload.conversationId, 'user', message);
        store.appendConversationTurn(payload.conversationId, 'assistant', data.reply);
        const resultIds = selectedIds.length ? selectedIds : toolCalls.flatMap(tool => tool.result.ranked?.map(row => row.planId) ?? []);
        store.updateSession(payload.conversationId, { lastPlanRefs: resultIds.map(planId => ({ planId, planName: catalog.getPlan(planId)?.name ?? planId })), lastPlanId: resultIds.length === 1 ? resultIds[0] : null });
      } else data = await assistant.runAssistantChat({ message, planId: payload.planId || planIds[0] || null, conversationId: payload.conversationId });
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
