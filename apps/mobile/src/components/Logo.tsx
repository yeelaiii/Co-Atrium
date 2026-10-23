import { SvgXml } from 'react-native-svg';

import { useTheme } from '@/theme/use-theme';

import { logoXml, markXml } from './logo-xml';

type Props = { width?: number };

// Mark is 1:1, full logo is 724:150.
export function LogoMark({ width = 40 }: Props) {
  const { textPrimary } = useTheme();
  return <SvgXml xml={markXml} width={width} height={width} color={textPrimary} accessibilityLabel="Co-Atrium" />;
}

export function Logo({ width = 240 }: Props) {
  const { textPrimary } = useTheme();
  return <SvgXml xml={logoXml} width={width} height={(width * 150) / 724} color={textPrimary} accessibilityLabel="Co-Atrium" />;
}
