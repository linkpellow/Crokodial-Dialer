import { useId } from 'react';
import { motion } from 'framer-motion';

interface GlassCheckboxProps {
  checked: boolean;
  onChange: () => void;
  label: React.ReactNode;
  disabled?: boolean;
  id?: string;
}

export function GlassCheckbox({
  checked,
  onChange,
  label,
  disabled = false,
  id: idProp,
}: GlassCheckboxProps) {
  const reactId = useId();
  const inputId = idProp ?? reactId.replace(/:/g, '');

  return (
    <label
      htmlFor={inputId}
      className="flex items-center gap-2 cursor-pointer hover:bg-white/5 p-2 rounded-lg min-h-[44px] transition-colors duration-150 select-none"
    >
      <input
        id={inputId}
        type="checkbox"
        checked={checked}
        onChange={() => !disabled && onChange()}
        disabled={disabled}
        className="sr-only"
        aria-checked={checked}
      />
      <span
        aria-hidden="true"
        className={`
          flex shrink-0 items-center justify-center w-6 h-6 rounded-md border transition-all duration-150
          active:scale-[0.97]
          ${checked
            ? 'bg-white/[0.06] border-lime-400/60 shadow-[0_0_12px_rgba(163,230,53,0.2)] ring-2 ring-lime-400/30'
            : 'bg-white/[0.06] border-white/20 hover:border-white/30'}
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
        `}
      >
        <motion.svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="rgb(163 230 53)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <motion.path
            d="M3 7l3 3 5-6"
            initial={false}
            animate={{ pathLength: checked ? 1 : 0, opacity: checked ? 1 : 0 }}
            transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
          />
        </motion.svg>
      </span>
      <span className="text-white/80 text-sm">{label}</span>
    </label>
  );
}
