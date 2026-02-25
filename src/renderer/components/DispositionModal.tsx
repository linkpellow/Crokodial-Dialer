/**
 * DispositionModal - Post-call outcome capture.
 * Utopian glass design with scale-in animation.
 * Renders via Portal to document.body so it overlays the entire app.
 *
 * @see dialerblueprint.md Section 4, Step 4 Persistence & Polishing
 */

import { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';

const DISPOSITIONS = [
  'No Answer',
  'Busy',
  'Closed',
  'Follow Up',
  'Not Interested',
  'Other',
] as const;

export interface DispositionModalProps {
  open: boolean;
  contactId: string | null;
  onSave: (disposition: string, notes: string) => Promise<{ ok: boolean; error?: string }>;
  onSkip: () => void;
  onClose?: () => void;
}

export function DispositionModal({
  open,
  contactId,
  onSave,
  onSkip,
}: DispositionModalProps) {
  const [selectedDisposition, setSelectedDisposition] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    setSaveError(null);
    setSaving(true);
    try {
      const disposition = selectedDisposition || 'Other';
      const result = await onSave(disposition, notes);
      if (!result.ok) {
        setSaveError(result.error ?? 'Failed to save');
        return;
      }
      setSelectedDisposition('');
      setNotes('');
    } finally {
      setSaving(false);
    }
  }, [selectedDisposition, notes, onSave]);

  const handleSkip = useCallback(() => {
    setSelectedDisposition('');
    setNotes('');
    setSaveError(null);
    onSkip();
  }, [onSkip]);

  const modal = (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center"
          style={{
            WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
            background: 'rgba(0,0,0,0.6)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ type: 'spring', damping: 25, stiffness: 400 }}
            className="w-[284px] rounded-xl p-5 flex flex-col gap-4"
            style={{
              background: 'rgba(26, 61, 26, 0.88)',
              backdropFilter: 'blur(16px)',
              WebkitBackdropFilter: 'blur(16px)',
              border: '1px solid rgba(255,255,255,0.12)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08)',
            }}
          >
            <h2 className="text-white font-semibold text-sm">Call Ended</h2>
            <p className="text-white/85 text-xs leading-relaxed">
              Save the outcome for this contact.
            </p>

            <div className="flex flex-col gap-2">
              <label className="text-white/90 text-xs font-medium">Disposition</label>
              <div className="grid grid-cols-2 gap-1.5">
                {DISPOSITIONS.map((d) => (
                  <motion.button
                    key={d}
                    type="button"
                    onClick={() => setSelectedDisposition(d)}
                    whileTap={{ scale: 0.97 }}
                    whileHover={{ scale: 1.02 }}
                    className={`py-2 px-2.5 rounded-lg text-xs font-medium transition-colors ${
                      selectedDisposition === d
                        ? 'text-white'
                        : 'text-white/90 hover:bg-white/10'
                    }`}
                    style={{
                      background: selectedDisposition === d
                        ? 'linear-gradient(180deg, #a8e063 0%, #7cb342 50%, #5a8a0f 100%)'
                        : 'rgba(0,0,0,0.2)',
                      boxShadow: selectedDisposition === d
                        ? 'inset 0 1px 0 rgba(255,255,255,0.2), 0 2px 4px rgba(0,0,0,0.2)'
                        : 'inset 0 2px 4px rgba(0,0,0,0.25)',
                    }}
                  >
                    {d}
                  </motion.button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="disposition-notes" className="text-white/90 text-xs font-medium">
                Notes
              </label>
              <textarea
                id="disposition-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional notes..."
                rows={2}
                className="w-full text-white text-sm rounded-lg px-3 py-2 placeholder-white/40 resize-none focus:outline-none focus:ring-2 focus:ring-white/30"
                style={{
                  background: 'rgba(0,0,0,0.25)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.3)',
                }}
              />
            </div>

            {saveError && (
              <p
                className="text-sm text-red-300"
                role="alert"
              >
                {saveError}
              </p>
            )}

            <div className="flex gap-2 justify-end mt-1">
              <motion.button
                type="button"
                onClick={handleSkip}
                whileTap={{ scale: 0.96 }}
                whileHover={{ scale: 1.02 }}
                className="px-3 py-2 rounded-lg text-xs font-medium text-white/95"
                style={{
                  background: 'rgba(0,0,0,0.25)',
                  boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.25)',
                  border: '1px solid rgba(255,255,255,0.06)',
                }}
              >
                Skip
              </motion.button>
              <motion.button
                type="button"
                onClick={handleSave}
                disabled={saving}
                whileTap={saving ? {} : { scale: 0.96 }}
                whileHover={saving ? {} : { scale: 1.02 }}
                className="px-4 py-2 rounded-lg text-xs font-medium text-white disabled:opacity-60"
                style={{
                  background: 'linear-gradient(180deg, #a8e063 0%, #7cb342 50%, #5a8a0f 100%)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.2), 0 2px 6px rgba(0,0,0,0.2)',
                  border: '1px solid rgba(255,255,255,0.15)',
                }}
              >
                {saving ? 'Saving...' : 'Save'}
              </motion.button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return createPortal(modal, document.body);
}
