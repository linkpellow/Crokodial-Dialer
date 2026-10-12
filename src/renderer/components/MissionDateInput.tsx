/**
 * Native single-day adaptation of the web dialer's MissionDateRangeInput.
 * Retains its 42-cell grid, month controls, portal positioning, focus handling,
 * and dark/lime visual tokens. A day commits immediately in the workspace.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import './mission-date-input.css';

const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const key = (date: Date) => date.toISOString().slice(0, 10);
const parse = (date: string) => new Date(`${date}T12:00:00Z`);

export function buildCalendarMonth(year: number, month: number): { date: string; day: number; currentMonth: boolean }[] {
  const first = new Date(Date.UTC(year, month, 1, 12));
  const start = new Date(first); start.setUTCDate(1 - first.getUTCDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start); date.setUTCDate(start.getUTCDate() + index);
    return { date: key(date), day: date.getUTCDate(), currentMonth: date.getUTCMonth() === month };
  });
}

export function MissionDateInput({ date, today, label, disabled, onChange }: {
  date: string; today: string; label: string; disabled?: boolean; onChange: (date: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => parse(date));
  const containerRef = useRef<HTMLDivElement>(null), triggerRef = useRef<HTMLButtonElement>(null), dropdownRef = useRef<HTMLDivElement>(null);
  const dialogId = useId();
  const [rect, setRect] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const positioned = rect !== null;
  const close = useCallback(() => { setOpen(false); triggerRef.current?.focus(); }, []);
  const select = useCallback((value: string) => { onChange(value); close(); }, [onChange, close]);

  useEffect(() => { if (open) setView(parse(date)); }, [open, date]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) { setRect(null); return; }
    const position = () => {
      if (!triggerRef.current) return;
      const trigger = triggerRef.current.getBoundingClientRect(), margin = 8;
      const width = Math.min(324, Math.max(0, window.innerWidth - margin * 2));
      const top = trigger.bottom + margin;
      setRect({ top, left: Math.max(margin, Math.min(trigger.left, window.innerWidth - width - margin)), width, maxHeight: Math.max(0, window.innerHeight - top - margin) });
    };
    position();
    const frame = window.requestAnimationFrame(position);
    window.addEventListener('scroll', position, true); window.addEventListener('resize', position);
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener('scroll', position, true); window.removeEventListener('resize', position); };
  }, [open, view]);
  useEffect(() => {
    if (!open || !positioned) return;
    (dropdownRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
      ?? dropdownRef.current?.querySelector<HTMLButtonElement>('button[data-today="true"]')
      ?? dropdownRef.current?.querySelector<HTMLButtonElement>('button[data-calendar-day]'))?.focus();
  }, [open, positioned]);
  useEffect(() => {
    if (!open) return;
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.key === 'Tab' && dropdownRef.current) {
        const buttons = Array.from(dropdownRef.current.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        else if (!dropdownRef.current.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      }
    };
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !dropdownRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('keydown', keyboard); document.addEventListener('mousedown', outside);
    return () => { document.removeEventListener('keydown', keyboard); document.removeEventListener('mousedown', outside); };
  }, [open, close]);

  const year = view.getUTCFullYear(), month = view.getUTCMonth();
  return <div className="mission-date-input" ref={containerRef}>
    <button ref={triggerRef} type="button" className="mission-date-trigger" disabled={disabled} onClick={() => setOpen(current => !current)}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? dialogId : undefined} aria-label={`Choose appointments date, ${label}`} data-selected-date={date}>
      <span>{label}</span><ChevronDown size={12} className={open ? 'open' : ''}/>
    </button>
    {open && rect && createPortal(<div ref={dropdownRef} id={dialogId} className="mission-date-calendar" data-mission-date-range-portal="true" role="dialog" aria-modal="true" aria-label="Choose date" style={rect}>
      <div className="mission-calendar-heading">
        <button type="button" aria-label="Previous month" onClick={() => setView(new Date(Date.UTC(year, month - 1, 1, 12)))}><ChevronLeft size={16}/></button>
        <span>{MONTH_NAMES[month]} {year}</span>
        <button type="button" aria-label="Next month" onClick={() => setView(new Date(Date.UTC(year, month + 1, 1, 12)))}><ChevronRight size={16}/></button>
      </div>
      <div className="mission-calendar-grid">
        {DAYS.map((day, index) => <div className="mission-calendar-weekday" key={index}>{day}</div>)}
        {buildCalendarMonth(year, month).map(day => <button type="button" key={day.date} data-calendar-day={day.date} data-today={day.date === today || undefined}
          className={`mission-calendar-day${day.currentMonth ? '' : ' outside-month'}${day.date === date ? ' selected' : ''}${day.date === today ? ' today' : ''}`}
          aria-pressed={day.date === date} aria-current={day.date === today ? 'date' : undefined}
          aria-label={parse(day.date).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
          onClick={() => select(day.date)}>{day.day}</button>)}
      </div>
      <div className="mission-calendar-footer"><button type="button" onClick={() => select(today)}>Today</button></div>
    </div>, document.body)}
  </div>;
}
