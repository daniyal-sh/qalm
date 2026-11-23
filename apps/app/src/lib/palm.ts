/** Plain words for the ink surface's rejected-touch codes, shown in Settings' test area. */
const REASONS: Record<string, string> = {
  'pen-only': 'Ignored: only the pen writes (fingers scroll)',
  'palm-size': 'Ignored: looked like a palm',
  'pen-lockout': 'Ignored: too soon after the pen',
  'hand-side': 'Ignored: on your writing hand’s side',
  'pen-active': 'Ignored: the pen is writing',
  'pen-took-over': 'Ignored: the pen took over',
  'multi-touch': 'Ignored: more than one finger',
  cancelled: 'Ignored: the system stopped that touch',
};

export function rejectedTouchText(reason: string): string {
  return REASONS[reason] ?? 'Ignored that touch';
}
