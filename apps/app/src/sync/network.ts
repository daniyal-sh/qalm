import type { WatchNetwork } from './provider';

/** Web and desktop: the browser's online/offline events, and the page becoming visible again. */
export const watchNetwork: WatchNetwork = (events) => {
  if (typeof window === 'undefined') return () => undefined;
  const onVisible = () => {
    if (document.visibilityState === 'visible') events.foreground();
  };
  window.addEventListener('online', events.online);
  window.addEventListener('offline', events.offline);
  document.addEventListener('visibilitychange', onVisible);
  if (navigator.onLine === false) events.offline();
  return () => {
    window.removeEventListener('online', events.online);
    window.removeEventListener('offline', events.offline);
    document.removeEventListener('visibilitychange', onVisible);
  };
};
