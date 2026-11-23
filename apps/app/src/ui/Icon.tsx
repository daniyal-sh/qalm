import Feather from '@expo/vector-icons/Feather';
import * as React from 'react';

import { useTheme } from '../theme/ThemeProvider';

export type IconName = React.ComponentProps<typeof Feather>['name'];

export function Icon({ name, size = 18, color }: { name: IconName; size?: number; color?: string }) {
  const { c } = useTheme();
  return <Feather name={name} size={size} color={color ?? c.ink2} />;
}
