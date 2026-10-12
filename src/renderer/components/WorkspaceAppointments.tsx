import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  appointmentsApi, appointmentName, appointmentKey, appointmentStatusBadge, appointmentTimeSlot, linkedAppointmentContact,
  localDateValue, shiftAppointmentDate, viewerTimeZone,
  type AppointmentDisposition, type AppointmentSelection, type WorkspaceAppointment,
} from '../services/appointmentsApiService';
import './appointments.css';
import { MissionDateInput } from './MissionDateInput';

export function useWorkspaceAppointments(selected: AppointmentSelection | null) {
  const [timeZone, setTimeZone] = useState(viewerTimeZone);
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
  const [noticeKey, setNoticeKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const generation = useRef(0), catalogGeneration = useRef(0);
  const savingRef = useRef(false), mounted = useRef(true);
  const dateRef = useRef(date); dateRef.current = date;
  const rowsRef = useRef(rows); rowsRef.current = rows;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++generation.current; ++catalogGeneration.current; }; }, []);
  const load = useCallback(async (background = false) => {
    if (savingRef.current) return;
    const request = ++generation.current;
    if (!background) { setLoading(true); setLoadError(''); }
    try {
      const next = await appointmentsApi.list(date, timeZone);
      if (mounted.current && request === generation.current) { setRows(next); setLoadError(''); }
    } catch (failure) {
      if (mounted.current && request === generation.current) {
        if (!background) setRows([]);
        setLoadError(failure instanceof Error ? failure.message : 'Unable to refresh appointments.');
      }
    } finally { if (mounted.current && request === generation.current) setLoading(false); }
  }, [date, timeZone]);
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
      setNow(new Date());
      const currentZone = viewerTimeZone();
      if (currentZone !== timeZone) { setTimeZone(currentZone); return; }
      // The selected calendar day is user state: a refresh, even across
      // midnight or a timezone preference change, must never advance it.
      void load(true);
    };
    const timer = setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); ++generation.current; };
  }, [load, timeZone]);

  async function save(appointment: WorkspaceAppointment, value: string) {
    if (savingRef.current) return;
    const key = appointmentKey(appointment), contactId = linkedAppointmentContact(appointment), currentDate = date;
    // A background refresh may remove/reassociate the selected appointment.
    // Never send a stale contact binding back through the canonical mutation.
    if (!contactId || !rowsRef.current.some(row => appointmentKey(row) === key && linkedAppointmentContact(row) === contactId)) {
      setSaveError({ key, message: 'This appointment changed. Reopen it from the list before updating its disposition.' });
      return;
    }
    savingRef.current = true; ++generation.current; setLoading(false); setSaving(key); setSaveError(null); setNotice('');
    try {
      const result = await appointmentsApi.saveDisposition(appointment, value || null);
      if (!mounted.current || currentDate !== dateRef.current) return;
      setRows(current => current.map(row => linkedAppointmentContact(row) === contactId && row.contact ? {
        ...row, contact: { ...row.contact, last_call_disposition: result.disposition,
          ...(Object.prototype.hasOwnProperty.call(result, 'clientStatus') ? { client_status: result.clientStatus } : {}) },
      } : row));
      setNoticeKey(key); setNotice(result.noShow?.notice || '');
    } catch (failure) {
      if (mounted.current && currentDate === dateRef.current) setSaveError({ key, message: failure instanceof Error ? failure.message : 'Disposition was not saved. Please retry.' });
    } finally {
      savingRef.current = false;
      if (mounted.current) { setSaving(null); if (currentDate === dateRef.current) void load(true); }
    }
  }

  const today = localDateValue(now, timeZone);
  const heading = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', weekday: 'short' });
  const selectedAppointment = selected ? rows.find(row => row.id === selected.id && linkedAppointmentContact(row) === selected.contactId) ?? null : null;
  const refresh = () => { setNow(new Date()); void load(true); void loadCatalog(); };
  return {
    date, today, heading, rows, selectedAppointment, now, timeZone, loading, loadError, catalog, catalogLoading,
    catalogError, saving, saveError, notice, noticeKey, setDate, refresh, retryLoad: () => void load(),
    retryCatalog: () => void loadCatalog(), saveDisposition: save,
  };
}

export type WorkspaceAppointmentsModel = ReturnType<typeof useWorkspaceAppointments>;

export function WorkspaceAppointments({ model, selecting, onSelect, searchControl }: {
  model: WorkspaceAppointmentsModel; selecting: boolean; onSelect: (appointment: WorkspaceAppointment) => void;
  searchControl?: (heading: ReactNode) => ReactNode;
}) {
  const { date, today, heading, rows, selectedAppointment, now, timeZone, loading, loadError, saving } = model;
  const title = <h2><CalendarDays size={17}/>{date === today ? 'Today’s appointments' : 'Appointments'}</h2>;
  return <section className="workspace-appointments" aria-label="Appointments">
    <div className="appointments-heading">{searchControl ? searchControl(title) : title}</div>
    <div className="appointments-date">
      <button className="icon-button" disabled={Boolean(saving)} aria-label="Previous day" onClick={() => model.setDate(shiftAppointmentDate(date, -1))}><ChevronLeft size={17}/></button>
      <MissionDateInput date={date} today={today} label={heading} disabled={Boolean(saving)} onChange={model.setDate}/>
      <button className="icon-button" disabled={Boolean(saving)} aria-label="Next day" onClick={() => model.setDate(shiftAppointmentDate(date, 1))}><ChevronRight size={17}/></button>
      <button className="appointments-today" disabled={Boolean(saving) || date === today} onClick={() => model.setDate(localDateValue(new Date(), timeZone))}>Today</button>
    </div>
    {loading && <p className="notes-muted" role="status">Loading appointments…</p>}
    {loadError && <p className="assistant-error" role="alert">{loadError} <button onClick={model.retryLoad}>Retry</button></p>}
    {!loading && !loadError && rows.length === 0 && <p className="notes-muted appointments-empty">No appointments for this date.</p>}
    <div className="appointments-list" tabIndex={rows.length ? 0 : -1} aria-label="Appointment list">
      {rows.map(appointment => {
        const key = appointmentKey(appointment), contactId = linkedAppointmentContact(appointment), name = appointmentName(appointment);
        const selectedRow = selectedAppointment === appointment;
        const time = appointmentTimeSlot(appointment, timeZone), status = appointmentStatusBadge(appointment, now, !loadError, timeZone);
        const showStatus = ['no-show', 'needed', 'client'].includes(status.tone);
        return <article className={`appointment-mini${selectedRow ? ' selected' : ''}`} key={key} data-appointment-id={appointment.id}>
          <button className="appointment-select" disabled={!contactId || selecting} aria-pressed={selectedRow} onClick={() => onSelect(appointment)} aria-label={`Open notes for ${name}, ${time}${showStatus ? `, ${status.text}` : ''}`} title={!contactId ? 'No linked contact. Search for a contact to open their notes.' : undefined}>
            {showStatus && <span className={`appointment-status-tab ${status.tone}`} title={status.text} aria-label={status.text}/>}
            <span className="appointment-summary"><time dateTime={appointment.scheduled_at}>{time}</time><strong>{name}</strong></span>
            <ChevronRight className="appointment-chevron" size={16} aria-hidden="true"/>
          </button>
        </article>;
      })}
    </div>
  </section>;
}

export function AppointmentDispositionControl({ model, appointment }: {
  model: WorkspaceAppointmentsModel; appointment: WorkspaceAppointment | null;
}) {
  const { catalog, catalogLoading, catalogError, saving, saveError } = model;
  const key = appointment ? appointmentKey(appointment) : null;
  const current = appointment ? model.rows.find(row => appointmentKey(row) === key && linkedAppointmentContact(row) === linkedAppointmentContact(appointment)) : null;
  const editable = Boolean(current && linkedAppointmentContact(current) && Number.isSafeInteger(current.id) && Number(current.id) > 0);
  const disposition = current?.contact?.last_call_disposition ?? '';
  const rowError = saveError?.key === key ? saveError?.message : '';
  return <div className="appointment-disposition-control">
    <select className="appointment-disposition" aria-label="Disposition" value={disposition} disabled={!editable || Boolean(saving) || Boolean(catalogError) || catalogLoading} aria-busy={Boolean(saving) || catalogLoading} aria-invalid={Boolean(rowError)} onChange={event => { if (current) void model.saveDisposition(current, event.target.value); }}>
      <option value="">No Disposition</option>
      {disposition && !catalog.some(option => option.name === disposition) && <option value={disposition}>{disposition}</option>}
      {catalog.map(option => <option key={option.id} value={option.name}>{option.name}</option>)}
    </select>
    {catalogError && <p className="assistant-error" role="alert">{catalogError} <button onClick={model.retryCatalog}>Retry dispositions</button></p>}
    {rowError && <p role="alert" className="assistant-error">{rowError}</p>}
    {model.notice && model.noticeKey === key && <p className="appointments-notice" role="status">{model.notice}</p>}
  </div>;
}
