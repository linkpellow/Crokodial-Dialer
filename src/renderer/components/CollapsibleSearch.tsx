import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import './collapsibleSearch.css';

/** Shared search disclosure: an empty search takes no space beyond its icon. */
export function CollapsibleSearch({ id, value, onChange, header, children, placeholder = 'Name or phone', label = 'Search' }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  header?: ReactNode;
  children?: ReactNode;
  placeholder?: string;
  label?: string;
}) {
  const [expanded, setExpanded] = useState(Boolean(value));
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!expanded) return;
    input.current?.focus({ preventScroll: true });
  }, [expanded]);
  useEffect(() => {
    if (!expanded || value) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setExpanded(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [expanded, value]);
  function close() {
    // A collapsed search must never leave an invisible filter applied.
    onChange(''); setExpanded(false); trigger.current?.focus({ preventScroll: true });
  }
  return <div ref={root} className="workspace-search-disclosure" data-expanded={expanded} onKeyDown={event => {
    if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <div className="workspace-search-toolbar">
      <div className="workspace-search-heading">{header}</div>
      <button ref={trigger} type="button" className="icon-button workspace-search-trigger" aria-label={expanded ? 'Close search' : label} title={expanded ? 'Close search' : label} aria-controls={`${id}-reveal`} aria-expanded={expanded} onClick={() => expanded ? close() : setExpanded(true)}>
        {expanded ? <X size={17} aria-hidden="true"/> : <Search size={17} aria-hidden="true"/>}
      </button>
    </div>
    <div id={`${id}-reveal`} className="workspace-search-reveal" aria-hidden={!expanded}>
      <div className="workspace-search-reveal-inner">
        <div className="workspace-search-field">
          <Search size={14} aria-hidden="true"/>
          <input ref={input} id={id} type="search" aria-label={label} placeholder={placeholder} value={value} tabIndex={expanded ? 0 : -1} autoComplete="off" spellCheck={false} onChange={event => onChange(event.target.value)}/>
        </div>
        {children}
      </div>
    </div>
  </div>;
}
