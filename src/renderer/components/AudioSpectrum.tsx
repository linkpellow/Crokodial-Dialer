import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useAudioAnalyser } from '@/renderer/hooks/useAudioAnalyser';

interface AudioSpectrumProps {
  stream: MediaStream | null;
}

const BAR_COUNT = 48;
const VOICE_BIN_RATIO = 0.72; // focus on lower 72% of bins (voice-frequency range)

/**
 * Real-time audio spectrum visualiser driven by a MediaStream.
 * Renders mirrored vertical bars (symmetric around horizontal centre) on a canvas,
 * styled to match the lime-green glow aesthetic of the app.
 */
export function AudioSpectrum({ stream }: AudioSpectrumProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number>(0);
  const analyserRef = useAudioAnalyser(stream);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Respect device pixel ratio for crisp rendering
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.offsetWidth || 280;
    const cssH = canvas.offsetHeight || 72;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;

    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    const draw = () => {
      frameRef.current = requestAnimationFrame(draw);

      const W = cssW;
      const H = cssH;
      ctx.clearRect(0, 0, W, H);

      // ── Gather frequency data ──────────────────────────────────────────────
      const analyser = analyserRef.current;
      const binCount = analyser ? Math.floor(analyser.frequencyBinCount * VOICE_BIN_RATIO) : BAR_COUNT;
      const rawData = new Uint8Array(analyser ? analyser.frequencyBinCount : BAR_COUNT);
      analyser?.getByteFrequencyData(rawData);

      // ── Layout ────────────────────────────────────────────────────────────
      const barSlot = W / BAR_COUNT;
      const barW = barSlot * 0.6;
      const xPad = (barSlot - barW) / 2;
      const centerY = H / 2;
      const maxH = centerY * 0.88;

      // ── Draw bars ─────────────────────────────────────────────────────────
      for (let i = 0; i < BAR_COUNT; i++) {
        const binIdx = Math.floor((i / BAR_COUNT) * binCount);
        const normalized = (rawData[binIdx] ?? 0) / 255; // 0–1
        const barH = Math.max(1.5, normalized * maxH);   // keep a 1.5 px baseline

        const x = i * barSlot + xPad;

        // Vertical gradient: bright lime tip → deep green centre → bright lime tip
        const alpha = 0.35 + normalized * 0.65;
        const grad = ctx.createLinearGradient(x, centerY - barH, x, centerY + barH);
        grad.addColorStop(0,    `rgba(210, 255, 100, ${alpha})`);
        grad.addColorStop(0.28, `rgba(130, 240,  55, ${alpha})`);
        grad.addColorStop(0.5,  `rgba( 60, 200,  30, ${alpha * 0.85})`);
        grad.addColorStop(0.72, `rgba(130, 240,  55, ${alpha})`);
        grad.addColorStop(1,    `rgba(210, 255, 100, ${alpha})`);

        // Glow — scales with amplitude
        ctx.shadowColor = `rgba(140, 255, 70, ${normalized * 0.85})`;
        ctx.shadowBlur  = 4 + normalized * 14;

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect(x, centerY - barH, barW, barH * 2, 2);
        ctx.fill();
      }

      // Reset shadow so nothing bleeds into the next frame clear
      ctx.shadowBlur = 0;
    };

    draw();
    return () => cancelAnimationFrame(frameRef.current);
  }, []); // canvas is stable; analyserRef.current is read live each frame

  return (
    <motion.div
      initial={{ opacity: 0, scaleY: 0.6 }}
      animate={{ opacity: 1, scaleY: 1 }}
      exit={{ opacity: 0, scaleY: 0.6 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="shrink-0 w-full rounded-xl overflow-hidden"
      style={{
        height: '72px',
        background: 'rgba(0, 10, 2, 0.82)',
        border: '1px solid rgba(120, 255, 70, 0.12)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), 0 2px 16px rgba(0,0,0,0.35)',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
    </motion.div>
  );
}
