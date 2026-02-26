import { useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useAudioAnalyser } from '@/renderer/hooks/useAudioAnalyser';

interface AudioSpectrumProps {
  stream: MediaStream | null;
  shutDown?: boolean;
  onShutdownComplete?: () => void;
}

const BAR_COUNT = 48;
const VOICE_BIN_RATIO = 0.72; // focus on lower 72% of bins (voice-frequency range)

// CRT shutdown timing (ms)
const CRT_COLLAPSE_MS = 280;   // bars collapse into a horizontal scanline
const CRT_PINCH_MS = 200;      // scanline pinches into a centre dot
const CRT_FLASH_MS = 80;       // bright flash
const CRT_BLACK_MS = 60;       // hard cut to black
const CRT_TOTAL_MS = CRT_COLLAPSE_MS + CRT_PINCH_MS + CRT_FLASH_MS + CRT_BLACK_MS;

/**
 * Real-time audio spectrum visualiser driven by a MediaStream.
 * Renders mirrored vertical bars (symmetric around horizontal centre) on a canvas,
 * styled to match the lime-green glow aesthetic of the app.
 *
 * When `shutDown` becomes true the bars play a CRT TV turn-off effect:
 * vertical collapse → bright scanline → pinch to dot → flash → hard-cut to black.
 */
export function AudioSpectrum({ stream, shutDown, onShutdownComplete }: AudioSpectrumProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number>(0);
  const analyserRef = useAudioAnalyser(stream);

  // Track the last "live" frequency snapshot so the CRT collapse starts from
  // the waveform shape that was showing when the call ended.
  const lastDataRef = useRef<Uint8Array>(new Uint8Array(BAR_COUNT));

  // CRT state
  const crtStartRef = useRef<number | null>(null);
  const crtDoneRef = useRef(false);

  const onComplete = useCallback(() => {
    onShutdownComplete?.();
  }, [onShutdownComplete]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

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

      // ── CRT shutdown sequence ──────────────────────────────────────────
      if (shutDown && !crtDoneRef.current) {
        if (crtStartRef.current === null) {
          crtStartRef.current = performance.now();
        }
        const elapsed = performance.now() - crtStartRef.current;
        drawCRT(ctx, W, H, elapsed, lastDataRef.current);

        if (elapsed >= CRT_TOTAL_MS) {
          crtDoneRef.current = true;
          cancelAnimationFrame(frameRef.current);
          // Fill black one last time
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, W, H);
          onComplete();
        }
        return;
      }

      // ── Normal live spectrum ───────────────────────────────────────────
      const analyser = analyserRef.current;
      const binCount = analyser ? Math.floor(analyser.frequencyBinCount * VOICE_BIN_RATIO) : BAR_COUNT;
      const rawData = new Uint8Array(analyser ? analyser.frequencyBinCount : BAR_COUNT);
      analyser?.getByteFrequencyData(rawData);

      // Snapshot for CRT collapse starting shape
      for (let i = 0; i < BAR_COUNT; i++) {
        const binIdx = Math.floor((i / BAR_COUNT) * binCount);
        lastDataRef.current[i] = rawData[binIdx] ?? 0;
      }

      // ── Layout ──────────────────────────────────────────────────────────
      const barSlot = W / BAR_COUNT;
      const barW = barSlot * 0.6;
      const xPad = (barSlot - barW) / 2;
      const centerY = H / 2;
      const maxH = centerY * 0.88;

      // ── Draw bars ───────────────────────────────────────────────────────
      for (let i = 0; i < BAR_COUNT; i++) {
        const binIdx = Math.floor((i / BAR_COUNT) * binCount);
        const normalized = (rawData[binIdx] ?? 0) / 255;
        const barH = Math.max(1.5, normalized * maxH);

        const x = i * barSlot + xPad;

        const alpha = 0.35 + normalized * 0.65;
        const grad = ctx.createLinearGradient(x, centerY - barH, x, centerY + barH);
        grad.addColorStop(0,    `rgba(210, 255, 100, ${alpha})`);
        grad.addColorStop(0.28, `rgba(130, 240,  55, ${alpha})`);
        grad.addColorStop(0.5,  `rgba( 60, 200,  30, ${alpha * 0.85})`);
        grad.addColorStop(0.72, `rgba(130, 240,  55, ${alpha})`);
        grad.addColorStop(1,    `rgba(210, 255, 100, ${alpha})`);

        ctx.shadowColor = `rgba(140, 255, 70, ${normalized * 0.85})`;
        ctx.shadowBlur  = 4 + normalized * 14;

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect(x, centerY - barH, barW, barH * 2, 2);
        ctx.fill();
      }

      ctx.shadowBlur = 0;
    };

    draw();
    return () => cancelAnimationFrame(frameRef.current);
  }, [shutDown]); // re-run when shutDown flips so CRT kicks in immediately

  return (
    <motion.div
      initial={{ opacity: 0, scaleY: 0.6 }}
      animate={{ opacity: 1, scaleY: 1 }}
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

// ─── CRT shutdown drawing ───────────────────────────────────────────────────

function drawCRT(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  elapsed: number,
  frozenData: Uint8Array,
) {
  const centerY = H / 2;
  const maxH = centerY * 0.88;
  const barSlot = W / BAR_COUNT;
  const barW = barSlot * 0.6;
  const xPad = (barSlot - barW) / 2;

  // Phase 1: Vertical collapse — bars squeeze down to a 2px bright scanline
  if (elapsed < CRT_COLLAPSE_MS) {
    const t = elapsed / CRT_COLLAPSE_MS;
    // Ease-in (accelerating): t²
    const ease = t * t;
    const scaleY = 1 - ease;                // 1 → 0
    const scanlineH = 2;                     // target scanline thickness
    const brightness = 0.6 + t * 0.4;       // bars get brighter as they collapse

    for (let i = 0; i < BAR_COUNT; i++) {
      const normalized = (frozenData[i] ?? 0) / 255;
      const fullBarH = Math.max(1.5, normalized * maxH);
      const barH = Math.max(scanlineH / 2, fullBarH * scaleY);

      const x = i * barSlot + xPad;
      const alpha = (0.35 + normalized * 0.65) * brightness;

      ctx.shadowColor = `rgba(180, 255, 120, ${normalized * brightness})`;
      ctx.shadowBlur = 6 + normalized * 16;

      const grad = ctx.createLinearGradient(x, centerY - barH, x, centerY + barH);
      grad.addColorStop(0,   `rgba(220, 255, 140, ${alpha})`);
      grad.addColorStop(0.5, `rgba(160, 255, 80, ${alpha * 0.9})`);
      grad.addColorStop(1,   `rgba(220, 255, 140, ${alpha})`);

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(x, centerY - barH, barW, barH * 2, 1);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    return;
  }

  // Phase 2: Scanline pinches into a centre dot
  const phase2Elapsed = elapsed - CRT_COLLAPSE_MS;
  if (phase2Elapsed < CRT_PINCH_MS) {
    const t = phase2Elapsed / CRT_PINCH_MS;
    // Ease-in-out
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const lineW = W * (1 - ease);          // full width → 0
    const dotR = Math.max(1.5, lineW / 2);
    const lineX = (W - lineW) / 2;
    const brightness = 1.0 + t * 0.3;       // gets hotter

    ctx.shadowColor = `rgba(200, 255, 160, ${0.9})`;
    ctx.shadowBlur = 12 + t * 20;

    // Draw the shrinking scanline
    ctx.fillStyle = `rgba(200, 255, 160, ${brightness > 1 ? 1 : brightness})`;
    ctx.beginPath();
    if (lineW > 4) {
      ctx.roundRect(lineX, centerY - 1.5, lineW, 3, 1.5);
    } else {
      // Tiny dot
      ctx.arc(W / 2, centerY, dotR, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.shadowBlur = 0;
    return;
  }

  // Phase 3: Bright flash from the dot
  const phase3Elapsed = elapsed - CRT_COLLAPSE_MS - CRT_PINCH_MS;
  if (phase3Elapsed < CRT_FLASH_MS) {
    const t = phase3Elapsed / CRT_FLASH_MS;
    const flashAlpha = 1 - t;               // 1 → 0

    // Central flash glow
    const grad = ctx.createRadialGradient(W / 2, centerY, 0, W / 2, centerY, W * 0.35);
    grad.addColorStop(0, `rgba(230, 255, 200, ${flashAlpha})`);
    grad.addColorStop(0.3, `rgba(180, 255, 120, ${flashAlpha * 0.6})`);
    grad.addColorStop(1, `rgba(80, 200, 40, 0)`);

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    return;
  }

  // Phase 4: Hard cut to black
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
}
