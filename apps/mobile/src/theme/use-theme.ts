import { useColorScheme } from 'react-native';

import { colors, type Theme } from './colors';

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? colors.dark : colors.light;
}
