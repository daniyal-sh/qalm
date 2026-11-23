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
import { SessionProvider } from '../src/state/session';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';

// Electron: qalm:// links (email magic-link sign-in) arrive as in-app routes from the preload.
function useDesktopDeepLinks(ready: boolean) {
  React.useEffect(() => {
    const d = desktop();
    if (!ready || !d) return;
    return d.onDeepLink((path) => router.push(path as never));
  }, [ready]);
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
