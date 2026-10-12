import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import './contactFilterPopover.css';

export interface ContactFilterValue {
  sort: 'newest' | 'oldest' | 'name_asc' | 'name_desc';
  state: string;
  disposition: string;
  vendor: string;
  timezone: string;
}

export const DEFAULT_CONTACT_FILTERS: ContactFilterValue = {
  sort: 'newest', state: '', disposition: '', vendor: '', timezone: '',
};

interface ContactFilterOptions { states: string[]; dispositions: string[]; vendors: string[]; timezones: string[] }
type FilterField = 'state' | 'disposition' | 'vendor' | 'timezone';
const EMPTY_OPTIONS: ContactFilterOptions = { states: [], dispositions: [], vendors: [], timezones: [] };
const STATE_NAMES: Record<string, string> = Object.fromEntries('AL:Alabama|AK:Alaska|AZ:Arizona|AR:Arkansas|CA:California|CO:Colorado|CT:Connecticut|DE:Delaware|DC:District of Columbia|FL:Florida|GA:Georgia|HI:Hawaii|ID:Idaho|IL:Illinois|IN:Indiana|IA:Iowa|KS:Kansas|KY:Kentucky|LA:Louisiana|ME:Maine|MD:Maryland|MA:Massachusetts|MI:Michigan|MN:Minnesota|MS:Mississippi|MO:Missouri|MT:Montana|NE:Nebraska|NV:Nevada|NH:New Hampshire|NJ:New Jersey|NM:New Mexico|NY:New York|NC:North Carolina|ND:North Dakota|OH:Ohio|OK:Oklahoma|OR:Oregon|PA:Pennsylvania|RI:Rhode Island|SC:South Carolina|SD:South Dakota|TN:Tennessee|TX:Texas|UT:Utah|VT:Vermont|VA:Virginia|WA:Washington|WV:West Virginia|WI:Wisconsin|WY:Wyoming|PR:Puerto Rico|VI:U.S. Virgin Islands|GU:Guam'.split('|').map(entry => entry.split(':')));
const FIELDS: { key: FilterField; label: string; empty: string; options: keyof ContactFilterOptions }[] = [
  { key: 'state', label: 'State', empty: 'All states', options: 'states' },
  { key: 'disposition', label: 'Disposition', empty: 'All dispositions', options: 'dispositions' },
  { key: 'vendor', label: 'Vendor', empty: 'All vendors', options: 'vendors' },
  { key: 'timezone', label: 'Timezone', empty: 'Any timezone', options: 'timezones' },
];

function optionLabel(field: FilterField, value: string): string {
  if (field === 'state') return STATE_NAMES[value.toUpperCase()] || value;
  if (field === 'disposition') {
    if (value === '__none__') return 'No disposition';
    if (/^follow[ _-]?up[ _-]needed$/i.test(value)) return 'Follow-up needed';
    const label = value.replace(/_/g, ' ');
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  return field === 'timezone' ? value.replace(/_/g, ' ') : value;
}

/** Draft filters only reach the contact query when Apply is pressed. */
export function ContactFilterPopover({ value, onChange, loadOptions, active = true }: {
  value: ContactFilterValue;
  onChange: (value: ContactFilterValue) => void;
  loadOptions: () => Promise<ContactFilterOptions>;
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ContactFilterValue>(value);
  const [options, setOptions] = useState<ContactFilterOptions>(EMPTY_OPTIONS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLDivElement>(null), coordinateProbe = useRef<HTMLDivElement>(null);
  const request = useRef(0), loader = useRef(loadOptions);
  loader.current = loadOptions;
  const id = useId();
  const count = FIELDS.filter(field => Boolean(value[field.key])).length;
  const positioned = position !== null;

  const close = useCallback(() => {
    request.current += 1;
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }, []);

  const fetchOptions = useCallback(async () => {
    const current = ++request.current;
    setLoading(true); setError(false);
    try {
      const result = await loader.current();
      if (current === request.current) setOptions(result);
    } catch {
      if (current === request.current) setError(true);
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) { setPosition(null); return; }
    void fetchOptions();
    return () => { request.current += 1; };
  }, [open, fetchOptions]);

  useEffect(() => {
    if (!active) { request.current += 1; setOpen(false); }
  }, [active]);

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      if (!trigger.current || !coordinateProbe.current) return;
      const button = trigger.current.getBoundingClientRect();
      // A fixed probe accounts for CSS zoom on document ancestors; DOM rects
      // use viewport pixels while fixed-position CSS values use local pixels.
      const probe = coordinateProbe.current.getBoundingClientRect();
      const scale = probe.width / 100 || 1;
      const margin = 8, gap = 10;
      const width = Math.min(336 * scale, Math.max(0, window.innerWidth - margin * 2));
      const left = Math.max(margin, Math.min(button.right - width, window.innerWidth - margin - width));
      const top = Math.min(button.bottom + gap, window.innerHeight - margin);
      const pointer = Math.max(15 * scale, Math.min(button.left + button.width / 2 - left, width - 15 * scale));
      setPosition({
        top: (top - probe.top) / scale, left: (left - probe.left) / scale,
        width: width / scale, maxHeight: Math.max(0, window.innerHeight - top - margin) / scale,
        '--contact-filter-pointer': `${pointer / scale}px`,
      } as CSSProperties);
    };
    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (open && positioned) dialog.current?.querySelector<HTMLSelectElement>('select')?.focus({ preventScroll: true });
  }, [open, positioned]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !dialog.current?.contains(event.target)) close();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key !== 'Tab' || !dialog.current) return;
      const controls = Array.from(dialog.current.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button:not([disabled]), select:not([disabled])'));
      const first = controls[0], last = controls[controls.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      else if (!dialog.current.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keyboard, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keyboard, true); };
  }, [open, close]);

  return <>
    <button ref={trigger} type="button" className="icon-button contact-filter-trigger" data-active={open || count > 0 || undefined}
      aria-label={count ? `Filter and sort contacts, ${count} filters applied` : 'Filter and sort contacts'} title="Filter & sort"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${id}-dialog` : undefined}
      onClick={() => { if (open) close(); else { setDraft({ ...value }); setOpen(true); } }}>
      <SlidersHorizontal size={17} aria-hidden="true"/>
      {count > 0 && <span className="contact-filter-count" aria-hidden="true">{count}</span>}
    </button>
    {open && createPortal(<>
      <div ref={coordinateProbe} className="contact-filter-coordinate-probe" aria-hidden="true"/>
      <div ref={dialog} id={`${id}-dialog`} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
        className="contact-filter-popover" style={position ?? { visibility: 'hidden', top: 0, left: 0 }}>
        <form className="contact-filter-panel" onSubmit={event => { event.preventDefault(); onChange({ ...draft }); close(); }}>
          <header className="contact-filter-heading">
            <h2 id={`${id}-title`}>Filter &amp; sort</h2>
            <button type="button" aria-label="Close filter and sort" onClick={close}><X size={18} aria-hidden="true"/></button>
          </header>
          <div className="contact-filter-row contact-filter-sort">
            <label htmlFor={`${id}-sort`}>Sort by</label>
            <div className="contact-filter-select">
              <select id={`${id}-sort`} value={draft.sort} onChange={event => setDraft(current => ({ ...current, sort: event.target.value as ContactFilterValue['sort'] }))}>
                <option value="newest">Newest first</option><option value="oldest">Oldest first</option>
                <option value="name_asc">Name A–Z</option><option value="name_desc">Name Z–A</option>
              </select>
              <ChevronDown size={14} aria-hidden="true"/>
            </div>
          </div>
          {FIELDS.map(field => {
            const available = Array.from(new Set([
              ...(field.key === 'disposition' ? ['__none__'] : []),
              ...options[field.options], ...(draft[field.key] ? [draft[field.key]] : []),
            ])).filter(Boolean);
            return <div className="contact-filter-row" key={field.key}>
              <label htmlFor={`${id}-${field.key}`}>{field.label}</label>
              <div className="contact-filter-select">
                <select id={`${id}-${field.key}`} value={draft[field.key]} onChange={event => setDraft(current => ({ ...current, [field.key]: event.target.value }))}>
                  <option value="">{field.empty}</option>
                  {available.map(option => <option key={option} value={option}>{optionLabel(field.key, option)}</option>)}
                </select>
                <ChevronDown size={14} aria-hidden="true"/>
              </div>
            </div>;
          })}
          {loading && <p className="contact-filter-loading" role="status">Loading filter options…</p>}
          {error && <p className="contact-filter-error" role="alert">Couldn’t load filter options. <button type="button" onClick={() => void fetchOptions()}>Retry</button></p>}
          <footer className="contact-filter-footer">
            <button type="button" className="contact-filter-reset" onClick={() => setDraft({ ...DEFAULT_CONTACT_FILTERS })}>Reset</button>
            <button type="submit" className="contact-filter-apply">Apply</button>
          </footer>
        </form>
      </div>
    </>, document.body)}
  </>;
}
