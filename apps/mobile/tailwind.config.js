// Semantic tokens from the Co-Atrium brand guide. Keep in sync with src/theme/colors.ts.
// Each colour has a light value (DEFAULT) and a `dark` value: `bg-background dark:bg-background-dark`.
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        background: { DEFAULT: '#F4F1EA', dark: '#0E1C20' },
        surface: { DEFAULT: '#FBF9F4', dark: '#14262B' },
        border: { DEFAULT: '#DDD8CC', dark: '#2A4046' },
        'text-primary': { DEFAULT: '#14262B', dark: '#F4F1EA' },
        'text-secondary': { DEFAULT: '#4A5B60', dark: '#A9B8BB' },
        accent: { DEFAULT: '#B93A16', dark: '#F0714A' },
        'text-on-accent': { DEFAULT: '#FFFFFF', dark: '#14262B' },
      },
      fontFamily: {
        manrope: ['Manrope_400Regular'],
        'manrope-semibold': ['Manrope_600SemiBold'],
        'manrope-bold': ['Manrope_700Bold'],
      },
      borderRadius: {
        card: '12px',
        button: '10px',
      },
    },
  },
};
