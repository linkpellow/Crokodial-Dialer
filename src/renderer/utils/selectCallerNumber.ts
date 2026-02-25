/**
 * selectCallerNumber - Chooses a caller ID from available numbers
 * with optional area-code/state matching for lead.
 *
 * @see dialerblueprint.md Section 3 (Caller ID Selection)
 */

export interface LeadContextForSelection {
  state?: string;
  zip?: string;
  leadPhone?: string;
}

/** Extract area code (first 3 digits) from NANP number (+1XXXXXXXXXX). */
function getAreaCode(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 4 && digits.startsWith('1')) {
    return digits.slice(1, 4);
  }
  if (digits.length >= 3) {
    return digits.slice(0, 3);
  }
  return null;
}

/** US state to common area-code hints (simplified; not exhaustive). */
const STATE_AREA_CODES: Record<string, string[]> = {
  CA: ['213', '310', '415', '510', '619', '626', '650', '661', '707', '714', '818', '831', '858', '909', '916', '925', '949'],
  TX: ['210', '214', '254', '281', '325', '361', '409', '430', '432', '469', '512', '682', '713', '726', '737', '806', '817', '830', '832', '903', '915', '936', '940', '956', '972'],
  NY: ['212', '315', '347', '516', '518', '585', '607', '631', '646', '716', '718', '845', '914', '917'],
  FL: ['239', '305', '321', '352', '386', '407', '561', '727', '754', '772', '786', '813', '850', '863', '904', '941', '954'],
  IL: ['217', '224', '309', '312', '331', '618', '630', '708', '773', '815', '847'],
  OH: ['216', '220', '234', '330', '380', '419', '440', '513', '567', '614', '740', '937'],
  PA: ['215', '267', '272', '412', '445', '484', '570', '610', '717', '724', '814', '878'],
};

/** Reverse map: area code -> state. Built from STATE_AREA_CODES. */
const AREA_CODE_TO_STATE: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [state, codes] of Object.entries(STATE_AREA_CODES)) {
    for (const code of codes) {
      map[code] = state;
    }
  }
  return map;
})();

/** Derive state from area code (e.g. "212" -> "NY"). */
function getStateFromAreaCode(areaCode: string): string | null {
  return AREA_CODE_TO_STATE[areaCode] ?? null;
}

/** Derive state from phone number when state is missing (e.g. +12125551234 -> NY). */
function getStateFromPhoneNumber(phone: string): string | null {
  const ac = getAreaCode(phone);
  return ac ? getStateFromAreaCode(ac) : null;
}

/**
 * Select the best caller ID from available numbers.
 * Prioritizes area-code match to lead's zip, state, or (when missing) derived state from leadPhone; otherwise returns first.
 */
export function selectCallerNumber(
  availableNumbers: string[],
  leadContext?: LeadContextForSelection
): string {
  if (!availableNumbers.length) return '';

  let effectiveState = leadContext?.state;
  let effectiveZip = leadContext?.zip;
  if (!effectiveState && !effectiveZip && leadContext?.leadPhone) {
    effectiveState = getStateFromPhoneNumber(leadContext.leadPhone) ?? undefined;
  }
  if (!effectiveZip && !effectiveState) {
    return availableNumbers[0];
  }

  let targetAreaCodes: string[] = [];
  if (effectiveZip) {
    // Use first 3 digits of zip as area-code hint for some regions
    const zipDigits = effectiveZip.replace(/\D/g, '').slice(0, 3);
    if (zipDigits.length >= 3) {
      targetAreaCodes.push(zipDigits);
    }
  }
  if (effectiveState) {
    const stateCodes = STATE_AREA_CODES[effectiveState.toUpperCase()];
    if (stateCodes) {
      targetAreaCodes = [...targetAreaCodes, ...stateCodes];
    }
  }

  if (!targetAreaCodes.length) {
    return availableNumbers[0];
  }

  for (const num of availableNumbers) {
    const ac = getAreaCode(num);
    if (ac && targetAreaCodes.includes(ac)) {
      return num;
    }
  }

  return availableNumbers[0];
}
