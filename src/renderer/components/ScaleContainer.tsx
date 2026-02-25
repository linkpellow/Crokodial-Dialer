import { COMPACT_DESIGN_HEIGHT, DESIGN_HEIGHT, DESIGN_WIDTH, MAX_SCALE } from '@/shared/dialerConstants';
import { useWindowSize } from '@/renderer/hooks/useWindowSize';

interface ScaleContainerProps {
  children: React.ReactNode;
}

export function ScaleContainer({ children }: ScaleContainerProps) {
  const { width, height } = useWindowSize();
  const compactHeightThreshold = COMPACT_DESIGN_HEIGHT + 36;
  const isCompactMode = height <= compactHeightThreshold;
  const targetHeight = isCompactMode ? COMPACT_DESIGN_HEIGHT : DESIGN_HEIGHT;

  const scale = Math.min(
    width / DESIGN_WIDTH,
    height / targetHeight,
    MAX_SCALE
  );

  return (
    <div className="w-full h-full flex items-center justify-center overflow-hidden">
      <div
        style={{
          width: DESIGN_WIDTH,
          height: targetHeight,
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
        }}
        className="flex-shrink-0"
      >
        {children}
      </div>
    </div>
  );
}
