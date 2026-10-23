// Semantic tokens from the Co-Atrium brand guide, for the few places className can't reach
// (SVG `color`, ActivityIndicator). Keep in sync with tailwind.config.js.
export const colors = {
  light: {
    background: '#F4F1EA',
    surface: '#FBF9F4',
    border: '#DDD8CC',
    textPrimary: '#14262B',
    textSecondary: '#4A5B60',
    accent: '#B93A16',
    textOnAccent: '#FFFFFF',
  },
  dark: {
    background: '#0E1C20',
    surface: '#14262B',
    border: '#2A4046',
    textPrimary: '#F4F1EA',
    textSecondary: '#A9B8BB',
    accent: '#F0714A',
    textOnAccent: '#14262B',
  },
} as const;

export type Theme = (typeof colors)['light' | 'dark'];
