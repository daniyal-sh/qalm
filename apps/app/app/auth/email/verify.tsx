// Magic-link landing: https://<app>/auth/email/verify?token=… (web, MAGIC_LINK_URL) or qalm://auth/email/verify?token=… (native).
import { router, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import { verifyMagicLink } from '../../../src/auth/magicLink';
import { useSession } from '../../../src/state/session';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { Button } from '../../../src/ui/controls';
import { Text } from '../../../src/ui/Text';

export default function VerifyEmail() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const s = useSession();
  const { c } = useTheme();
  const [err, setErr] = React.useState<string | null>(null);
  const started = React.useRef(false);

  React.useEffect(() => {
    if (!s.ready || started.current) return;
    started.current = true;
    void (async () => {
      try {
        if (!token) throw new Error('This link has no sign-in token');
        if (!s.serverUrl) throw new Error('No server configured');
        const t = await verifyMagicLink(fetch, s.serverUrl, token);
        await s.signInWithTokens(t, { provider: 'email' });
        router.replace('/');
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [s.ready, token, s]);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24, backgroundColor: c.bg }}>
      {err ? (
        <>
          <Text variant="section">Can't sign in</Text>
          <Text tone="muted" style={{ textAlign: 'center' }}>
            {err}
          </Text>
          <Button label="Back to sign-in" variant="primary" onPress={() => router.replace('/sign-in')} />
        </>
      ) : (
        <>
          <ActivityIndicator color={c.accent} />
          <Text tone="muted">Signing you in…</Text>
        </>
      )}
    </View>
  );
}
