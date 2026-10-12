import { authenticatedFetch } from './dialerApiService';

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
export const platformUrl = (path: string) => `${API_BASE}${path}`;
export interface AssistantAgent { id: number; name: string; role: 'sales' | 'customer_service' | 'personal_assistant' }
export interface InsurancePlan { id: string; name: string; variants: Array<{ id: string; name: string; network?: string }> }
export interface AssistantReply {
  success?: boolean; message?: string; reply?: string; error?: string; model?: string;
  grounding?: { citations?: string[] };
  citations?: Array<{ tool?: string; planId?: string; detail?: string }>;
  proposedActions?: Array<{ name: string }>;
}

class AssistantApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'AssistantApiError';
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  if (!API_BASE) throw new Error('Crokodial connection is not configured. Set VITE_API_BASE and rebuild.');
  const response = await authenticatedFetch(platformUrl(path), {
    ...options,
    headers: { 'x-crokodial-contract-version': '2026-02-26.1', ...options?.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new AssistantApiError(body?.error?.message ?? body?.message ?? `Crokodial request failed (${response.status}).`, response.status, body?.error?.code);
  return (body?.data ?? body) as T;
}

export async function listPersonalAssistants(): Promise<AssistantAgent[]> {
  const agents = await request<AssistantAgent[]>('/api/ai-agents');
  return agents.filter(agent => agent.role === 'personal_assistant');
}
export async function listInsurancePlans(): Promise<InsurancePlan[]> {
  return (await request<{ plans: InsurancePlan[] }>('/api/insurance-plans')).plans;
}
export async function startAssistantSession(agentId: number): Promise<string> {
  const result = await request<{ sessionId: string }>(`/api/ai-agents/${agentId}/test/session`, { method: 'POST' });
  if (!result.sessionId) throw new Error('Crokodial did not create a conversation.');
  return result.sessionId;
}
export async function sendAssistantMessage(agentId: number, sessionId: string, message: string, workspacePlanHistory: string[] = []): Promise<AssistantReply> {
  const result = await request<AssistantReply>(`/api/ai-agents/${agentId}/test/message`, {
    method: 'POST', body: JSON.stringify({ sessionId, message, workspacePlanHistory, audience: 'agent', requestId: crypto.randomUUID() }),
  });
  if (!result.success || !result.message) throw new Error(result.error || 'The assistant could not produce a response.');
  return result;
}
export async function disposeAssistantSession(agentId: number, sessionId: string): Promise<void> {
  try {
    await request(`/api/ai-agents/${agentId}/test/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  } catch (error) {
    // Sessions live in server memory and may already be gone after a restart.
    // Only that exact absence completes reset; missing agents and auth errors
    // still need to reach the caller without discarding its local conversation.
    if (error instanceof AssistantApiError && error.status === 404 && error.code === 'NOT_FOUND' && error.message === 'Test session not found') return;
    throw error;
  }
}
export async function openPlatform(path: '/plans' | '/ai-assistants'): Promise<void> {
  if (!API_BASE) throw new Error('Crokodial connection is not configured.');
  if (window.dialer?.openExternal) await window.dialer.openExternal(platformUrl(path));
  else window.open(platformUrl(path), '_blank', 'noopener,noreferrer');
}
export interface PlanConfiguration {
  instructions: string;
  announcements: Array<{ id: string; title: string; body: string; active: boolean; effectiveFrom: string | null; expiresAt: string | null; affectedEffectiveFrom: string | null; affectedEffectiveTo: string | null }>;
  supportContacts: Array<{ id: string; label: string; email: string; purpose: string }>;
  documents: Array<{ id: number; filename: string; status: string }>;
}
export async function getPlanConfiguration(planId: string): Promise<PlanConfiguration> {
  return request(`/api/insurance-plans/${encodeURIComponent(planId)}`);
}
