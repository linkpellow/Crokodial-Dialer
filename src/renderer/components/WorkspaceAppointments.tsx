import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { getAppointmentFollowUpStatus } from '../../shared/appointmentFollowUpStatus';
import {
  appointmentsApi, appointmentName, appointmentKey, appointmentIsClient, linkedAppointmentContact,
  localDateValue, shiftAppointmentDate, viewerTimeZone,
  type AppointmentDisposition, type AppointmentSelection, type WorkspaceAppointment,
} from '../services/appointmentsApiService';
import './appointments.css';

export function WorkspaceAppointments({ selected, compact, selecting, onSelect }: {
  selected: AppointmentSelection | null; compact: boolean; selecting: boolean; onSelect: (appointment: WorkspaceAppointment) => void;
}) {
  const [date, setDate] = useState(() => localDateValue(new Date()));
  const [rows, setRows] = useState<WorkspaceAppointment[]>([]);
  const [catalog, setCatalog] = useState<AppointmentDisposition[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [saveError, setSaveError] = useState<{ key: string; message: string } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(() => new Date());
  const generation = useRef(0), catalogGeneration = useRef(0);
  const savingRef = useRef(false), mounted = useRef(true);
  const dateRef = useRef(date); dateRef.current = date;
  const todayRef = useRef(localDateValue(new Date()));

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++generation.current; ++catalogGeneration.current; }; }, []);
  const load = useCallback(async (background = false) => {
    if (savingRef.current) return;
    const request = ++generation.current;
    if (!background) { setLoading(true); setLoadError(''); }
    try {
      const next = await appointmentsApi.list(date);
      if (mounted.current && request === generation.current) { setRows(next); setLoadError(''); }
    } catch (failure) {
      if (mounted.current && request === generation.current) {
        if (!background) setRows([]);
        setLoadError(failure instanceof Error ? failure.message : 'Unable to refresh appointments.');
      }
    } finally { if (mounted.current && request === generation.current) setLoading(false); }
  }, [date]);
  const loadCatalog = useCallback(async () => {
    const request = ++catalogGeneration.current;
    setCatalogLoading(true);
    try {
      const next = await appointmentsApi.dispositions();
      if (mounted.current && request === catalogGeneration.current) { setCatalog(next); setCatalogError(''); }
    } catch (failure) {
      if (mounted.current && request === catalogGeneration.current) setCatalogError(failure instanceof Error ? failure.message : 'Unable to load dispositions.');
    } finally { if (mounted.current && request === catalogGeneration.current) setCatalogLoading(false); }
  }, []);
  useEffect(() => { void loadCatalog(); }, [loadCatalog]);
  useEffect(() => {
    setRows([]); setNotice(''); setSaveError(null); void load();
    const refresh = () => {
      if (document.hidden) return;
      const clock = new Date(), today = localDateValue(clock); setNow(clock);
      if (todayRef.current !== today) {
        const previousToday = todayRef.current; todayRef.current = today;
        if (dateRef.current === previousToday) { setDate(today); return; }
      }
      void load(true);
    };
    const timer = setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); ++generation.current; };
  }, [load]);

  async function save(appointment: WorkspaceAppointment, value: string) {
    if (savingRef.current) return;
    const key = appointmentKey(appointment), contactId = linkedAppointmentContact(appointment), currentDate = date;
    savingRef.current = true; ++generation.current; setLoading(false); setSaving(key); setSaveError(null); setNotice('');
    try {
      const result = await appointmentsApi.saveDisposition(appointment, value || null);
      if (!mounted.current || currentDate !== dateRef.current) return;
      setRows(current => current.map(row => row.contact_id === contactId && row.contact ? {
        ...row, contact: { ...row.contact, last_call_disposition: result.disposition,
          ...(Object.prototype.hasOwnProperty.call(result, 'clientStatus') ? { client_status: result.clientStatus } : {}) },
      } : row));
      setNotice(result.noShow?.notice || `Disposition saved for ${appointmentName(appointment)}.`);
    } catch (failure) {
      if (mounted.current && currentDate === dateRef.current) setSaveError({ key, message: failure instanceof Error ? failure.message : 'Disposition was not saved. Please retry.' });
    } finally {
      savingRef.current = false;
      if (mounted.current) { setSaving(null); if (currentDate === dateRef.current) void load(true); }
    }
  }

  const today = localDateValue(now);
  const heading = new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short' });
  return <section className={`workspace-appointments${compact ? ' has-selection' : ''}`} aria-label="Appointments">
    <div className="appointments-heading"><h2><CalendarDays size={13}/>{date === today ? 'Today’s appointments' : 'Appointments'}</h2><button className="icon-button" disabled={Boolean(saving) || loading} aria-label="Refresh appointments" onClick={() => { setNow(new Date()); void load(true); void loadCatalog(); }}><RefreshCw size={12}/></button></div>
    <div className="appointments-date">
      <button className="icon-button" disabled={Boolean(saving)} aria-label="Previous day" onClick={() => setDate(shiftAppointmentDate(date, -1))}><ChevronLeft size={13}/></button>
      <label><span>{heading}</span><input type="date" aria-label="Appointment date" value={date} disabled={Boolean(saving)} onChange={event => { if (event.target.value && /^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) setDate(event.target.value); }}/></label>
      <button className="icon-button" disabled={Boolean(saving)} aria-label="Next day" onClick={() => setDate(shiftAppointmentDate(date, 1))}><ChevronRight size={13}/></button>
      <button className="appointments-today" disabled={Boolean(saving) || date === today} onClick={() => setDate(localDateValue(new Date()))}>Today</button>
    </div>
    {loading && <p className="notes-muted" role="status">Loading appointments…</p>}
    {loadError && <p className="assistant-error" role="alert">{loadError} <button onClick={() => void load()}>Retry</button></p>}
    {catalogError && <p className="assistant-error" role="alert">{catalogError} <button onClick={() => void loadCatalog()}>Retry dispositions</button></p>}
    {notice && <p className="appointments-notice" role="status">{notice}</p>}
    {!loading && !loadError && rows.length === 0 && <p className="notes-muted appointments-empty">No appointments for this date. Choose another day or find a contact above.</p>}
    {rows.length > 0 && <div className="appointments-list" tabIndex={0} aria-label="Appointment list">
      {rows.map(appointment => {
        const key = appointmentKey(appointment), contactId = linkedAppointmentContact(appointment), name = appointmentName(appointment);
        const selectedRow = selected && selected.id === appointment.id && selected.contactId === contactId;
        const followUp = !loadError && !appointmentIsClient(appointment) ? getAppointmentFollowUpStatus(appointment, now, viewerTimeZone()) : null;
        const disposition = appointment.contact?.last_call_disposition ?? '';
        const editable = Boolean(contactId && Number.isSafeInteger(appointment.id) && Number(appointment.id) > 0);
        const rowError = saveError?.key === key ? saveError.message : '';
        const time = appointment.all_day ? 'All day' : new Date(appointment.scheduled_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        return <article className={`appointment-mini${selectedRow ? ' selected' : ''}`} key={key} data-appointment-id={appointment.id}>
          <button className="appointment-select" disabled={!contactId || selecting} aria-pressed={Boolean(selectedRow)} onClick={() => onSelect(appointment)} aria-label={`Open notes for ${name}, ${time}`}>
            <time dateTime={appointment.scheduled_at}>{time}</time><strong>{name}</strong>
          </button>
          <div className="appointment-mini-controls">
            <span className="appointment-meta">{followUp ? <span className={`appointment-follow-up ${followUp}`}>{followUp === 'scheduled' ? 'Follow Up Scheduled' : 'Follow Up Needed'}</span> : appointmentIsClient(appointment) ? 'Client' : selectedRow ? 'Selected' : !contactId ? 'No linked contact' : ''}</span>
            <select aria-label={`Disposition for ${name}, ${time}`} value={editable ? disposition : ''} disabled={!editable || Boolean(saving) || Boolean(catalogError) || catalogLoading} aria-busy={saving === key || catalogLoading} aria-invalid={Boolean(rowError)} onChange={event => void save(appointment, event.target.value)}>
              <option value="">{!editable ? 'Calendar only' : 'No disposition'}</option>
              {editable && disposition && !catalog.some(option => option.name === disposition) && <option value={disposition}>{disposition}</option>}
              {editable && catalog.map(option => <option key={option.id} value={option.name}>{option.name}</option>)}
            </select>
          </div>
          {!contactId && <small className="appointment-unlinked">Find a contact above to take notes.</small>}
          {saving === key && <small role="status">Saving disposition…</small>}
          {rowError && <p role="alert" className="assistant-error">{rowError}</p>}
        </article>;
      })}
    </div>}
    <small className="appointments-zone">Times in {viewerTimeZone().split('_').join(' ')} · Refreshes automatically</small>
  </section>;
}
