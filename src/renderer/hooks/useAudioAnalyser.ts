import { useEffect, useRef } from 'react';

/**
 * Connects a MediaStream to a Web Audio AnalyserNode.
 * Returns a stable ref whose `.current` is populated whenever a live stream is provided.
 * Automatically tears down the AudioContext when the stream changes or the component unmounts.
 */
export function useAudioAnalyser(stream: MediaStream | null): React.RefObject<AnalyserNode | null> {
  const analyserRef = useRef<AnalyserNode | null>(null);

  useEffect(() => {
    if (!stream) {
      analyserRef.current = null;
      return;
    }

    const audioCtx = new AudioContext();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;            // 64 frequency bins — ideal bar density
    analyser.smoothingTimeConstant = 0.78; // silky smoothing

    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);
    analyserRef.current = analyser;

    return () => {
      source.disconnect();
      audioCtx.close();
      analyserRef.current = null;
    };
  }, [stream]);

  return analyserRef;
}
