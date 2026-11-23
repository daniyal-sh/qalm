// Magic-link landing: https://<app>/auth/email/verify?token=… (web, MAGIC_LINK_URL) or qalm://auth/email/verify?token=… (native).
// Opening the page never uses the link up: it is POSTed to the server here, with this device's nonce when this device asked for it.
// A link this device didn't ask for (or one that would switch accounts) needs the user's confirmation first (login CSRF).
import { router, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import { pendingDeps } from '../../../src/auth/device';
import { lookupMagicLink, verifyMagicLink } from '../../../src/auth/magicLink';
import { clearPending, pendingNonce } from '../../../src/auth/pending';
import { useSession } from '../../../src/state/session';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { Button } from '../../../src/ui/controls';
import { Panel } from '../../../src/ui/layout';
import { Text } from '../../../src/ui/Text';

type Step = { kind: 'loading' } | { kind: 'confirm'; email: string; current: string | null; useNonce: boolean } | { kind: 'error'; message: string };

export default function VerifyEmail() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const s = useSession();
  const { c } = useTheme();
  const [step, setStep] = React.useState<Step>({ kind: 'loading' });
  const [busy, setBusy] = React.useState(false);
  const started = React.useRef(false);

  const complete = React.useCallback(
    async (email: string, useNonce: boolean) => {
      if (!token || !s.serverUrl) return;
      const nonce = useNonce ? await pendingNonce(pendingDeps, email) : null;
      const t = await verifyMagicLink(fetch, s.serverUrl, token, nonce ? { nonce } : { confirm: true });
      await clearPending(pendingDeps, email);
      await s.signInWithTokens(t, { provider: 'email', email: t.email || email }, { verified: !!nonce });
      router.replace('/');
    },
    [token, s],
  );

  React.useEffect(() => {
    if (!s.ready || started.current) return;
    started.current = true;
    void (async () => {
      try {
        if (!token) throw new Error('This link has no sign-in token');
        if (!s.serverUrl) throw new Error('No server configured');
        const email = await lookupMagicLink(fetch, s.serverUrl, token);
        const current = s.user ? (s.profile?.email ?? null) : null;
        if (s.user && current?.toLowerCase() === email) {
          router.replace('/'); // already signed in to that account
          return;
        }
        if (!s.user && (await pendingNonce(pendingDeps, email))) {
          try {
            await complete(email, true); // this device asked for the link
            return;
          } catch {
            // The nonce didn't match (e.g. the link was requested on another device too): ask.
            setStep({ kind: 'confirm', email, current: null, useNonce: false });
            return;
          }
        }
        setStep({ kind: 'confirm', email, current: s.user ? (current ?? 'another account') : null, useNonce: true });
      } catch (e) {
        setStep({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, [s.ready, token, s, complete]);

  const onContinue = (email: string, useNonce: boolean) => {
    setBusy(true);
    complete(email, useNonce).catch((e: unknown) => {
      setBusy(false);
      setStep({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    });
  };

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16, backgroundColor: c.bg }}>
      {step.kind === 'loading' ? (
        <View style={{ alignItems: 'center', gap: 16 }}>
          <ActivityIndicator color={c.accent} />
          <Text tone="muted">Signing you in…</Text>
        </View>
      ) : step.kind === 'error' ? (
        <Panel style={{ width: '100%', maxWidth: 440, padding: 24, gap: 16 }}>
          <Text variant="section">Can't sign in</Text>
          <Text tone="muted">{step.message}</Text>
          <Button label="Back to sign-in" variant="primary" onPress={() => router.replace('/sign-in')} />
        </Panel>
      ) : (
        <Panel style={{ width: '100%', maxWidth: 440, padding: 24, gap: 16 }}>
          <Text variant="section">{step.current ? `Switch to ${step.email}?` : `Sign in as ${step.email}?`}</Text>
          {step.current ? <Text tone="muted">You're signed in as {step.current}. This link signs you in to a different account.</Text> : null}
          <View style={[{ padding: 12, borderRadius: 8, backgroundColor: c.warnSoft }]}>
            <Text variant="label" tone="warn">
              Only continue if you just asked for this link. Someone who sends you a sign-in link can see what you save in their account.
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label="Cancel" grow onPress={() => router.replace('/')} disabled={busy} />
            <Button label="Continue" variant="primary" grow loading={busy} onPress={() => onContinue(step.email, step.useNonce)} />
          </View>
        </Panel>
      )}
    </View>
  );
}
