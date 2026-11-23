import * as AppleAuthentication from 'expo-apple-authentication';
import * as Google from 'expo-auth-session/providers/google';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as React from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { extractMagicToken, isEmail, startMagicLink, verifyMagicLink } from '../src/auth/magicLink';
import { config } from '../src/config';
import { useSession, type Profile } from '../src/state/session';
import { useTheme } from '../src/theme/ThemeProvider';
import { Lockup } from '../src/ui/brand';
import { Button, TextField } from '../src/ui/controls';
import { Divider, Panel } from '../src/ui/layout';
import { Text } from '../src/ui/Text';

WebBrowser.maybeCompleteAuthSession();

const googleClientId = Platform.select({ web: config.googleClientIds.web, ios: config.googleClientIds.ios, android: config.googleClientIds.android });

function GoogleButton({ onToken, busy }: { onToken(idToken: string): void; busy: boolean }) {
  const [request, response, prompt] = Google.useIdTokenAuthRequest({
    webClientId: config.googleClientIds.web,
    iosClientId: config.googleClientIds.ios,
    androidClientId: config.googleClientIds.android,
    selectAccount: true,
  });
  React.useEffect(() => {
    if (response?.type !== 'success') return;
    const t = response.params.id_token ?? response.authentication?.idToken;
    if (t) onToken(t);
  }, [response, onToken]);
  return <Button label="Continue with Google" icon="globe" disabled={!request || busy} onPress={() => void prompt()} />;
}

export default function SignIn() {
  const { c } = useTheme();
  const s = useSession();
  const [email, setEmail] = React.useState('');
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const [link, setLink] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [appleOk, setAppleOk] = React.useState(false);

  React.useEffect(() => {
    if (Platform.OS === 'ios') void AppleAuthentication.isAvailableAsync().then(setAppleOk);
  }, []);
  React.useEffect(() => {
    if (s.user) router.replace('/');
  }, [s.user]);

  const run = async (what: string, fn: () => Promise<void>) => {
    setErr(null);
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/canceled|cancelled/i.test(msg)) setErr(msg);
    } finally {
      setBusy(null);
    }
  };

  const idSignIn = async (provider: 'apple' | 'google', body: object, profile: Profile) => {
    await s.signInWith(`/auth/${provider}`, body, profile);
  };

  const onGoogle = React.useCallback(
    (idToken: string) => void run('google', () => idSignIn('google', { idToken }, { provider: 'google' })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.tm],
  );

  const onApple = () =>
    run('apple', async () => {
      const cred = await AppleAuthentication.signInAsync({
        requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL, AppleAuthentication.AppleAuthenticationScope.FULL_NAME],
      });
      if (!cred.identityToken) throw new Error('Apple returned no identity token');
      const name = [cred.fullName?.givenName, cred.fullName?.familyName].filter(Boolean).join(' ') || undefined;
      await idSignIn('apple', { identityToken: cred.identityToken, name }, { provider: 'apple', email: cred.email ?? undefined, name });
    });

  const onEmail = () =>
    run('email', async () => {
      if (!s.serverUrl) throw new Error('No server configured');
      await startMagicLink(fetch, s.serverUrl, email);
      setSentTo(email.trim());
    });

  const onLink = () =>
    run('link', async () => {
      const token = extractMagicToken(link);
      if (!token) throw new Error('Paste the whole link from the email');
      if (!s.serverUrl) throw new Error('No server configured');
      const t = await verifyMagicLink(fetch, s.serverUrl, token);
      await s.signInWithTokens(t, { provider: 'email', email: sentTo ?? undefined });
    });

  const skip = () => {
    s.setSkipped(true);
    router.replace('/');
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
        <Panel style={styles.card}>
          <Lockup size={22} />
          <View style={{ gap: 6 }}>
            <Text variant="title">Sign in</Text>
            <Text tone="muted">Your notebooks sync between your tablet and your computer. You can also use Qalm without an account.</Text>
          </View>

          {!s.serverUrl ? (
            <View style={[styles.note, { backgroundColor: c.warnSoft, borderColor: c.line }]}>
              <Text variant="label" tone="warn">
                This build has no sync server, so notebooks stay on this device.
              </Text>
            </View>
          ) : sentTo ? (
            <View style={{ gap: 12 }}>
              <View style={[styles.note, { backgroundColor: c.goodSoft, borderColor: c.line }]}>
                <Text variant="label" tone="good">
                  We sent a sign-in link to {sentTo}.
                </Text>
              </View>
              <Text tone="muted">Open the link on this device. If it opens somewhere else, paste it here.</Text>
              <TextField value={link} onChangeText={setLink} placeholder="Paste the link from the email" autoCapitalize="none" autoCorrect={false} icon="link" onSubmitEditing={onLink} />
              <Button label="Sign in" variant="primary" loading={busy === 'link'} disabled={!link.trim()} onPress={onLink} />
              <Button label="Use another email" variant="ghost" onPress={() => setSentTo(null)} />
            </View>
          ) : (
            <View style={{ gap: 10 }}>
              {appleOk ? <Button label="Continue with Apple" icon="smartphone" loading={busy === 'apple'} onPress={onApple} /> : null}
              {googleClientId ? <GoogleButton onToken={onGoogle} busy={!!busy} /> : null}
              {appleOk || googleClientId ? (
                <View style={styles.or}>
                  <Divider style={{ flex: 1 }} />
                  <Text variant="meta" tone="faint">
                    or
                  </Text>
                  <Divider style={{ flex: 1 }} />
                </View>
              ) : null}
              <TextField
                value={email}
                onChangeText={setEmail}
                placeholder="you@example.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect={false}
                icon="mail"
                onSubmitEditing={() => isEmail(email) && onEmail()}
                accessibilityLabel="Email"
              />
              <Button label="Email me a sign-in link" variant="primary" loading={busy === 'email'} disabled={!isEmail(email)} onPress={onEmail} />
            </View>
          )}

          {err ? (
            <Text variant="label" tone="bad" accessibilityRole="alert">
              {err}
            </Text>
          ) : null}

          <Divider />
          <Button label="Continue without an account" variant="ghost" onPress={skip} />
        </Panel>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 440, padding: 24, gap: 20 },
  note: { padding: 12, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  or: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 4 },
});
