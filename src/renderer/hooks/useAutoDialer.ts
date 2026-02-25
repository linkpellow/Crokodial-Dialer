/**
 * useAutoDialer - Auto-dial with 2500ms cooldown after disposition.
 * Cooldown starts only when Save or Skip is called on the disposition modal.
 *
 * @see dialerblueprint.md Section 6 (Logic Flow), Step 5 (Production Functional Integration)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchDialerLeads, type DialerLead } from '@/renderer/services/dialerApiService';
import type { LeadContext } from '@/renderer/utils/resolveCallerNumber';

const COOLDOWN_MS = 2500;

export interface UseAutoDialerActions {
  startAutoDial: () => void;
  stopAutoDial: () => void;
  signalDispositionComplete: () => void;
}

export type AutoDialerStatus = 'active' | 'idle' | 'queueEmpty' | 'disconnected';

export interface UseAutoDialerResult {
  isActive: boolean;
  currentLead: DialerLead | null;
  queueEmpty: boolean;
  status: AutoDialerStatus;
  actions: UseAutoDialerActions;
}

function leadToContext(lead: DialerLead): LeadContext {
  const firstName = (lead.firstName as string) ?? '';
  const lastName = (lead.lastName as string) ?? '';
  const leadName = [firstName, lastName].filter(Boolean).join(' ').trim() || 'Unknown';
  return {
    leadId: String(lead.id),
    leadName,
    leadPhone: (lead.e164 as string) ?? '',
  };
}

export function useAutoDialer(
  startCallWithLead: (dest: string, ctx: LeadContext) => void,
  connectionStatus: string,
  filters?: { dispositions?: string[] }
): UseAutoDialerResult {
  /** Auto-dial is OFF by default. User must explicitly click the Auto button to enable. */
  const [isActive, setIsActive] = useState(false);
  const [currentLead, setCurrentLead] = useState<DialerLead | null>(null);
  const [queueEmpty, setQueueEmpty] = useState(false);
  const cooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageRef = useRef(1);
  const isActiveRef = useRef(false);
  const connectionStatusRef = useRef(connectionStatus);
  isActiveRef.current = isActive;
  connectionStatusRef.current = connectionStatus;

  const dialNext = useCallback(() => {
    if (!isActiveRef.current) return;
    if (connectionStatusRef.current !== 'registered') {
      return;
    }

    fetchDialerLeads({
      page: pageRef.current,
      limit: 1,
      dispositions: filters?.dispositions?.length ? filters.dispositions.join(',') : undefined,
    })
      .then((leads: DialerLead[]) => {
        if (!isActiveRef.current) return;
        if (connectionStatusRef.current !== 'registered') return;

        if (leads.length === 0) {
          setCurrentLead(null);
          setQueueEmpty(true);
          setIsActive(false);
          isActiveRef.current = false;
          return;
        }
        setQueueEmpty(false);
        const lead = leads[0];
        const dest = (lead.e164 as string) ?? '';
        if (!dest) {
          pageRef.current += 1;
          dialNext();
          return;
        }
        setCurrentLead(lead);
        const ctx = leadToContext(lead);
        startCallWithLead(dest, ctx);
        pageRef.current += 1;
      })
      .catch((err: unknown) => {
        console.warn('[useAutoDialer] fetchDialerLeads error:', err);
        setCurrentLead(null);
      });
  }, [startCallWithLead, filters?.dispositions]);

  useEffect(() => {
    if (isActive) pageRef.current = 1;
  }, [filters?.dispositions]);

  const startAutoDial = useCallback(() => {
    setIsActive(true);
    isActiveRef.current = true;
    pageRef.current = 1;
    dialNext();
  }, [dialNext]);

  const stopAutoDial = useCallback(() => {
    if (cooldownRef.current) {
      clearTimeout(cooldownRef.current);
      cooldownRef.current = null;
    }
    setIsActive(false);
    isActiveRef.current = false;
    setCurrentLead(null);
    setQueueEmpty(false);
  }, []);

  const signalDispositionComplete = useCallback(() => {
    if (!isActiveRef.current) return;
    if (connectionStatusRef.current !== 'registered') return;
    if (cooldownRef.current) {
      clearTimeout(cooldownRef.current);
    }
    cooldownRef.current = setTimeout(() => {
      cooldownRef.current = null;
      dialNext();
    }, COOLDOWN_MS);
  }, [dialNext]);

  const status: AutoDialerStatus = !isActive
    ? 'idle'
    : queueEmpty
      ? 'queueEmpty'
      : connectionStatus !== 'registered'
        ? 'disconnected'
        : 'active';

  return {
    isActive,
    currentLead,
    queueEmpty,
    status,
    actions: {
      startAutoDial,
      stopAutoDial,
      signalDispositionComplete,
    },
  };
}
