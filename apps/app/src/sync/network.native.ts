import { AppState } from 'react-native';

import type { WatchNetwork } from './provider';

/**
 * iOS and Android: back in the foreground, check the connection at once (the OS often kills sockets in the
 * background without a close event). There are no online/offline events here; the heartbeat notices a lost network.
 */
export const watchNetwork: WatchNetwork = (events) => {
  const sub = AppState.addEventListener('change', (s) => {
    if (s === 'active') events.foreground();
  });
  return () => sub.remove();
};
