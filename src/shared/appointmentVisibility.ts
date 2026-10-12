/** Calendar buffer records remain stored for synchronization, but are not appointments. */
export function isGeneratedAppointmentBufferTitle(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  const title = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1).trim() : trimmed;
  return /^15\s*[-–—]?\s*minute\s+buffer(?:\s+(?:before|after)\s+\S(?:.*\S)?)?$/i.test(title);
}

/** Google copies of canceled provider bookings can retain a confirmed event status. */
export function isCanceledAppointmentTitle(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^cancel(?:ed|led)\s*:/i.test(value.trim());
}

export function isAppointmentVisible(appointment: {
  status?: string | null;
  appointment_type?: string | null;
}): boolean {
  const status = appointment.status?.trim().toLowerCase();
  return status !== 'cancelled' && status !== 'canceled' &&
    !isCanceledAppointmentTitle(appointment.appointment_type) &&
    !isGeneratedAppointmentBufferTitle(appointment.appointment_type);
}
