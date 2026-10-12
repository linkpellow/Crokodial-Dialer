import { useEffect, useState } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import type { UseDialerActions, UseDialerState } from '../hooks/useDialer';
import type { RecordingContact } from '../services/nativeRecordingController';

export interface ContactCalling {
  state: UseDialerState;
  actions: UseDialerActions;
}

/** One call engine serves every workspace. Navigation never starts or replaces a call. */
export function ContactCallControl({ contact, calling }: {
  contact: RecordingContact & { state?: string };
  calling?: ContactCalling;
}) {
  const [now, setNow] = useState(Date.now);
  const state = calling?.state;
  const active = Boolean(state && ['dialing', 'ringing', 'in_call', 'held'].includes(state.uiState));
  const connected = Boolean(state && ['in_call', 'held'].includes(state.uiState));
  const started = state?.connectedAt;
  useEffect(() => {
    if (!connected || !started) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [connected, started]);
  const seconds = Math.max(0, Math.floor((now - (started ?? now)) / 1000));
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const validPhone = /^\+?[1-9]\d{6,14}$/.test(contact.e164 || '');
  const unavailable = !calling ? 'Calling is unavailable.' : !validPhone ? 'This contact has no callable phone number.' : state?.connectionStatus !== 'registered' ? 'Open the dialer to connect calling.' : !state.availablePhoneNumbers.length ? 'No assigned caller number is available.' : '';
  return <div className="contact-call-control">
    {connected && started != null && <span className="contact-call-timer" aria-label="Call duration">{elapsed}</span>}
    <button className={`contact-call-button${active ? ' contact-call-end' : ''}`} aria-label={active ? 'End Call' : 'Call'}
      disabled={!active && Boolean(unavailable)} title={active ? `End current call${state?.phoneNumber ? ` · ${state.phoneNumber}` : ''}` : unavailable || `Call ${contact.name}`}
      onClick={() => {
        if (!calling) return;
        if (active) calling.actions.hangupCall();
        else void calling.actions.startCallWithLead(contact.e164, { leadId: String(contact.id), leadName: contact.name, leadPhone: contact.e164, state: contact.state }, 'contact');
      }}>
      {active ? <PhoneOff size={15}/> : <Phone size={15}/>}{active ? 'End Call' : 'Call'}
    </button>
  </div>;
}
