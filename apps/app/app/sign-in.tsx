import { router, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { Platform, ScrollView, StyleSheet, TextInput, View, type TextStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { pendingDeps } from '../src/auth/device';
import { isEmail, startMagicLink, verifyCode } from '../src/auth/magicLink';
import { beginEmailSignIn, clearPending, pendingNonce } from '../src/auth/pending';
import { cooldownLeft, readCodeInput, resendLabel } from '../src/auth/signInFlow';
import { useSession } from '../src/state/session';
import { useTheme } from '../src/theme/ThemeProvider';
import { Lockup } from '../src/ui/brand';
import { Button, TextField } from '../src/ui/controls';
import { Icon, type IconName } from '../src/ui/Icon';
import { Divider, Panel } from '../src/ui/layout';
import { Appear } from '../src/theme/motion';
import { font, radius, space } from '../src/theme/tokens';
import { Text } from '../src/ui/Text';

/** A solid tinted note with an icon: what happened, in one line or two. */
function Note({ tone, icon, children }: { tone: 'good' | 'warn' | 'bad'; icon: IconName; children: React.ReactNode }) {
  const { c } = useTheme();
  const fg = c[tone];
  const bg = tone === 'good' ? c.goodSoft : tone === 'warn' ? c.warnSoft : c.badSoft;
  return (
    <Appear distance={4} style={[styles.note, { backgroundColor: bg, borderColor: c.line }]}>
      <Icon name={icon} size={16} color={fg} />
      <Text variant="label" style={{ color: fg, flex: 1 }} accessibilityRole={tone === 'bad' ? 'alert' : undefined}>
        {children}
      </Text>
    </Appear>
  );
}

/** Ticks once a second while `on`, so the resend cooldown counts down. */
function useNow(on: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/**
 * Email-only sign-in: one field sends a link and a 6-digit code; then "Check your email" takes the code (or the pasted
 * link), with resend after a cooldown and "Use a different email". "Continue without an account" keeps qalm local.
 */
export default function SignIn() {
  const { c } = useTheme();
  const s = useSession();
  // After Settings → Delete account.
  const deleted = useLocalSearchParams<{ deleted?: string }>().deleted === '1';
  const [email, setEmail] = React.useState('');
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const [sentAt, setSentAt] = React.useState<number | null>(null);
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState<'send' | 'resend' | 'code' | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [resent, setResent] = React.useState(false);
  const codeRef = React.useRef<React.ComponentRef<typeof TextInput> | null>(null);
  const now = useNow(!!sentTo);
  const wait = cooldownLeft(sentAt, now);

  React.useEffect(() => {
    if (s.user) router.replace('/');
  }, [s.user]);

  const run = async (what: 'send' | 'resend' | 'code', fn: () => Promise<void>) => {
    setErr(null);
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const send = async (to: string) => {
    if (!s.serverUrl) throw new Error('No server configured');
    const { nonceHash } = await beginEmailSignIn(pendingDeps, to);
    await startMagicLink(fetch, s.serverUrl, to, nonceHash);
    setSentAt(Date.now());
  };

  const onSend = () =>
    void run('send', async () => {
      const to = email.trim();
      await send(to);
      setSentTo(to);
      setCode('');
      setResent(false);
    });

  const onResend = () =>
    void run('resend', async () => {
      if (!sentTo) return;
      await send(sentTo);
      setResent(true);
      setCode('');
      codeRef.current?.focus();
    });

  const submitCode = (value: string) =>
    void run('code', async () => {
      if (!s.serverUrl || !sentTo) throw new Error('No server configured');
      const nonce = await pendingNonce(pendingDeps, sentTo);
      if (!nonce) throw new Error('This code has expired. Send a new one.');
      const t = await verifyCode(fetch, s.serverUrl, sentTo, value, nonce);
      await clearPending(pendingDeps, sentTo);
      await s.signInWithTokens(t, { provider: 'email', email: t.email || sentTo });
    });

  const onCodeChange = (text: string) => {
    const r = readCodeInput(text);
    if (r.kind === 'link') {
      // The verify screen checks the link belongs to this device's request (or asks first).
      router.replace({ pathname: '/auth/email/verify', params: { token: r.token } });
      return;
    }
    const digits = r.kind === 'code' ? r.code : r.digits;
    setCode(digits);
    if (err) setErr(null);
    if (digits.length === 6 && busy !== 'code') submitCode(digits);
  };

  const differentEmail = () => {
    setSentTo(null);
    setSentAt(null);
    setCode('');
    setErr(null);
    setResent(false);
  };

  const skip = () => {
    s.setSkipped(true);
    router.replace('/');
  };

  const codeStyle: TextStyle = {
    color: c.ink,
    fontFamily: font.mono,
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: 10,
    textAlign: 'center',
    paddingVertical: 12,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null),
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
        <Panel style={styles.card}>
          <Lockup size={22} />

          {!s.serverUrl ? (
            <>
              <View style={{ gap: 6 }}>
                <Text variant="title">Welcome to qalm</Text>
                <Text tone="muted">This build has no sync server, so your notebooks stay on this device.</Text>
              </View>
              <Note tone="warn" icon="cloud-off">
                Sign-in isn't available in this build.
              </Note>
            </>
          ) : sentTo ? (
            <Appear distance={6} style={{ gap: space.xl }}>
              <View style={{ gap: 12 }}>
                <View style={[styles.badge, { backgroundColor: c.accentSoft, borderColor: c.accentLine }]}>
                  <Icon name="mail" size={20} color={c.accent} />
                </View>
                <Text variant="title">Check your email</Text>
                <Text tone="muted">
                  We sent a sign-in link and a 6-digit code to{' '}
                  <Text variant="bodyStrong" style={{ color: c.ink }}>
                    {sentTo}
                  </Text>
                  . Open the link on this device, or enter the code here.
                </Text>
              </View>

              <View style={{ gap: 8 }}>
                <Text variant="smallStrong" tone="muted">
                  Sign-in code
                </Text>
                <View style={[styles.codeBox, { backgroundColor: c.surface, borderColor: err ? c.bad : c.line }]}>
                  <TextInput
                    ref={codeRef}
                    value={code}
                    onChangeText={onCodeChange}
                    placeholder="000000"
                    placeholderTextColor={c.line}
                    keyboardType="number-pad"
                    autoComplete="one-time-code"
                    textContentType="oneTimeCode"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoFocus
                    onSubmitEditing={() => code.length === 6 && submitCode(code)}
                    accessibilityLabel="6-digit code from the email"
                    style={codeStyle}
                  />
                </View>
                <Text variant="meta" tone="faint">
                  You can also paste the whole link from the email. Codes expire in 15 minutes.
                </Text>
              </View>

              <Button label="Sign in" variant="primary" loading={busy === 'code'} disabled={code.length !== 6} onPress={() => submitCode(code)} />

              {resent && !err ? (
                <Note tone="good" icon="check">
                  We sent a new link and code.
                </Note>
              ) : null}
              {err ? (
                <Note tone="bad" icon="alert-circle">
                  {err}
                </Note>
              ) : null}

              <View style={styles.actions}>
                <Button label={resendLabel(wait)} variant="ghost" size="sm" icon="rotate-cw" loading={busy === 'resend'} disabled={wait > 0 || !!busy} onPress={onResend} />
                <Button label="Use a different email" variant="ghost" size="sm" onPress={differentEmail} />
              </View>
              <Text variant="meta" tone="faint">
                Can't find it? Check your spam or promotions folder.
              </Text>
            </Appear>
          ) : (
            <>
              {deleted ? (
                <Note tone="good" icon="check-circle">
                  Your account was deleted, with everything in it.
                </Note>
              ) : null}
              <View style={{ gap: 6 }}>
                <Text variant="title">Sign in to qalm</Text>
                <Text tone="muted">Enter your email and we'll send you a sign-in link and a 6-digit code. No password needed.</Text>
              </View>
              <View style={{ gap: 10 }}>
                <TextField
                  value={email}
                  onChangeText={(v) => {
                    setEmail(v);
                    if (err) setErr(null);
                  }}
                  placeholder="you@example.com"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  textContentType="emailAddress"
                  autoCorrect={false}
                  icon="mail"
                  onSubmitEditing={() => isEmail(email) && onSend()}
                  accessibilityLabel="Email"
                />
                <Button label="Email me a sign-in link" variant="primary" loading={busy === 'send'} disabled={!isEmail(email)} onPress={onSend} />
              </View>
              {err ? (
                <Note tone="bad" icon="alert-circle">
                  {err}
                </Note>
              ) : null}
            </>
          )}

          <Divider />
          <View style={{ gap: 4 }}>
            <Button label="Continue without an account" variant="ghost" onPress={skip} />
            <Text variant="meta" tone="faint" style={{ textAlign: 'center' }}>
              Notebooks stay on this device. Sign in later to sync them.
            </Text>
          </View>
        </Panel>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 420, padding: space.xxl, gap: space.xl },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: space.md, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  badge: { width: 44, height: 44, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  codeBox: { borderRadius: radius.control, borderWidth: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8, marginTop: -8 },
});
