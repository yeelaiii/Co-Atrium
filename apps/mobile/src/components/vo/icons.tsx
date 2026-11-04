import type { ColorValue } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

export type VoIconName =
  | 'thread'
  | 'camera'
  | 'mic'
  | 'stop'
  | 'send'
  | 'check'
  | 'clock'
  | 'play'
  | 'pause'
  | 'chevron-left'
  | 'chevron-right'
  | 'plus'
  | 'close'
  | 'image'
  | 'triage'
  | 'list';

// Line icons in the same style as TabIcon. Decorative: the control carrying the icon has the label.
export function VoIcon({ name, color, size = 22, strokeWidth = 1.9 }: { name: VoIconName; color: ColorValue; size?: number; strokeWidth?: number }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      {name === 'thread' && <Path d="M4 5h16v11H9l-5 4V5zM8 9.5h8M8 12.5h5" />}
      {name === 'camera' && (
        <>
          <Path d="M4 8h3l2-2.5h6L17 8h3v11H4V8z" />
          <Circle cx={12} cy={13} r={3.5} />
        </>
      )}
      {name === 'mic' && <Path d="M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM6 11a6 6 0 0012 0M12 17v4" />}
      {name === 'stop' && <Rect x={6.5} y={6.5} width={11} height={11} rx={2} fill={color} />}
      {name === 'send' && <Path d="M4 12l16-8-6 16-2.5-6.5L4 12z" />}
      {name === 'check' && <Path d="M5 12.5l4.5 4.5L19 7.5" />}
      {name === 'clock' && (
        <>
          <Circle cx={12} cy={12} r={8} />
          <Path d="M12 8v4.5l3 2" />
        </>
      )}
      {name === 'play' && <Path d="M8 5.5v13l10.5-6.5L8 5.5z" fill={color} />}
      {name === 'pause' && <Path d="M8 5.5v13M16 5.5v13" strokeWidth={3} />}
      {name === 'chevron-left' && <Path d="M15 5l-7 7 7 7" />}
      {name === 'chevron-right' && <Path d="M9 5l7 7-7 7" />}
      {name === 'plus' && <Path d="M12 5v14M5 12h14" />}
      {name === 'close' && <Path d="M6 6l12 12M18 6L6 18" />}
      {name === 'image' && (
        <>
          <Rect x={3.5} y={5} width={17} height={14} rx={2} />
          <Circle cx={9} cy={10} r={1.6} />
          <Path d="M20.5 16l-5-5-8 8" />
        </>
      )}
      {name === 'triage' && <Rect x={5} y={4} width={14} height={16} rx={2} />}
      {name === 'list' && <Path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" strokeWidth={2.2} />}
    </Svg>
  );
}
