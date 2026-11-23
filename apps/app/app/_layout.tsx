import { Figtree_400Regular, Figtree_500Medium, Figtree_600SemiBold, Figtree_700Bold } from '@expo-google-fonts/figtree';
import { GeistMono_400Regular } from '@expo-google-fonts/geist-mono';
import { useFonts } from 'expo-font';
import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { desktop } from '../src/lib/desktop';
import { SessionProvider, useSession } from '../src/state/session';
import { Button } from '../src/ui/controls';
import { Sheet } from '../src/ui/layout';
import { Text } from '../src/ui/Text';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';

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

function Shell() {
  const { c, scheme } = useTheme();
  const [fontsLoaded, fontError] = useFonts({ Figtree_400Regular, Figtree_500Medium, Figtree_600SemiBold, Figtree_700Bold, GeistMono_400Regular });
  useDesktopDeepLinks(fontsLoaded || !!fontError);
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
