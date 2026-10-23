import Svg, { Path } from 'react-native-svg';

import { useTheme } from '@/theme/use-theme';

// Dropdown indicator shown at the end of picker rows.
export function ChevronDown({ size = 20 }: { size?: number }) {
  const theme = useTheme();

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={theme.textSecondary} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Path d="M6 9l6 6 6-6" />
    </Svg>
  );
}
