/**
 * resolveCallerNumber - Auto vs manual caller ID selection.
 * Auto: filter by userAssignments, then selectCallerNumber by lead.
 * Manual: use selected E.164 if allowed, else fallback.
 *
 * @see dialerblueprint.md Section 3 (Caller ID Selection)
 */

import { selectCallerNumber } from './selectCallerNumber';

export interface LeadContext {
  leadId?: string;
  leadName?: string;
  leadPhone?: string;
  state?: string;
  zip?: string;
}

/**
 * Resolve the caller number for outbound calls.
 * - Auto: Filter availableNumbers by userAssignments, then selectCallerNumber with leadContext.
 * - Manual: If selectedE164 is in userAssignments, use it; else fallback.
 */
export function resolveCallerNumber(
  mode: 'auto' | string,
  selectedE164: string,
  availableNumbers: string[],
  userAssignments: string[],
  leadContext?: LeadContext
): string {
  const allowed = userAssignments.length > 0 ? userAssignments : availableNumbers;
  if (!allowed.length) return selectedE164 || availableNumbers[0] || '';

  if (mode === 'auto') {
    const candidates =
      userAssignments.length > 0
        ? availableNumbers.filter((n) => userAssignments.includes(n))
        : availableNumbers;
    const chosen = selectCallerNumber(candidates, {
      state: leadContext?.state,
      zip: leadContext?.zip,
      leadPhone: leadContext?.leadPhone,
    });
    return chosen || allowed[0] || '';
  }

  // Manual
  if (selectedE164 && userAssignments.includes(selectedE164)) {
    return selectedE164;
  }
  return allowed[0];
}
