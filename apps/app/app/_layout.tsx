import { Figtree_400Regular, Figtree_500Medium, Figtree_600SemiBold, Figtree_700Bold } from '@expo-google-fonts/figtree';
import { GeistMono_400Regular } from '@expo-google-fonts/geist-mono';
import { useFonts } from 'expo-font';
import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as React from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { persistClip } from '../src/editor/clipboard';
import { desktop } from '../src/lib/desktop';
import { useFullscreenShortcut } from '../src/lib/fullscreen';
import { PEN_DETECTED_TOAST } from '../src/lib/inputPrefs';
import { kvGet, kvSet } from '../src/lib/kv';
import { quietNonPrimaryMouseUp } from '../src/lib/webMouse';
import { SessionProvider, useSession } from '../src/state/session';
import { ConfirmHost } from '../src/ui/ConfirmHost';
import { Button } from '../src/ui/controls';
import { Sheet, useToast } from '../src/ui/layout';
import { Text } from '../src/ui/Text';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';

// Copy/Cut survive reloads and restarts (per device).
void persistClip({ get: () => kvGet('clipboard'), set: (c) => kvSet('clipboard', c) });
if (Platform.OS === 'web') quietNonPrimaryMouseUp();

// Web / Electron: Ctrl/Cmd+A outside a text field would select every label in the window (the editor handles its own
// Ctrl+A, selecting the page's items, and calls preventDefault first).
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented || !(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== 'a') return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    ev.preventDefault();
  });
}

// Electron: qalm:// links (email magic-link sign-in) arrive as in-app routes from the preload.
function useDesktopDeepLinks(ready: boolean) {
  React.useEffect(() => {
    const d = desktop();
    if (!ready || !d) return;
    return d.onDeepLink((path) => router.push(path as never));
  }, [ready]);
}

/**
 * After a sign-in this device didn't ask for (a confirmed magic link), notebooks made here while signed out are
 * only moved into the account when the user says so.
 */
function MoveLocalOffer() {
  const s = useSession();
  const [busy, setBusy] = React.useState(false);
  const n = s.localOffer;
  const who = s.profile?.email ?? 'this account';
  return (
    <Sheet
      visible={n > 0}
      onClose={s.dismissLocalOffer}
      title={`Move ${n} notebook${n === 1 ? '' : 's'} into this account?`}
      width={440}
      footer={
        <>
          <Button label="Not now" onPress={s.dismissLocalOffer} disabled={busy} />
          <Button
            label="Move notebooks"
            variant="primary"
            loading={busy}
            onPress={() => {
              setBusy(true);
              void s.moveLocal().finally(() => setBusy(false));
            }}
          />
        </>
      }
    >
      <Text tone="muted">
        {n === 1
          ? `A notebook was made on this device without an account. Moving it syncs it to ${who}. Only move it if this is your account.`
          : `${n} notebooks were made on this device without an account. Moving them syncs them to ${who}. Only move them if this is your account.`}
      </Text>
    </Sheet>
  );
}

/** The one-time toast when the first pen this device shows switches "draw with" to pen only. */
function PenDetectedToast() {
  const { penSwitched } = useTheme();
  const [toast, show] = useToast();
  React.useEffect(() => {
    if (penSwitched) show(PEN_DETECTED_TOAST);
  }, [penSwitched, show]);
  return toast;
}

function Shell() {
  const { c, scheme } = useTheme();
  const [fontsLoaded, fontError] = useFonts({ Figtree_400Regular, Figtree_500Medium, Figtree_600SemiBold, Figtree_700Bold, GeistMono_400Regular });
  useDesktopDeepLinks(fontsLoaded || !!fontError);
  useFullscreenShortcut();
  if (!fontsLoaded && !fontError) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg }, animation: 'fade' }} />
      <MoveLocalOffer />
      <ConfirmHost />
      <PenDetectedToast />
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <SessionProvider>
            <Shell />
          </SessionProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
