import type { ColorValue } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

export type TabIconName = 'home' | 'search' | 'folder' | 'profile';

// Placeholder line icons for the tab bar; swap for final artwork later.
export function TabIcon({ name, color, size = 26 }: { name: TabIconName; color: ColorValue; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {name === 'home' && <Path d="M4 11l8-7 8 7M6 10v10h12V10" />}
      {name === 'search' && (
        <>
          <Circle cx={11} cy={11} r={6.5} />
          <Path d="M16 16l4.5 4.5" />
        </>
      )}
      {name === 'folder' && <Path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />}
      {name === 'profile' && (
        <>
          <Circle cx={12} cy={8} r={4} />
          <Path d="M4 20c0-4 3.5-6 8-6s8 2 8 6" />
        </>
      )}
    </Svg>
  );
}
