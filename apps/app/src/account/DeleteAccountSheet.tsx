import { router } from 'expo-router';
import * as React from 'react';
import { Platform, StyleSheet, TextInput, View, type TextStyle } from 'react-native';

import { isEmail } from '../auth/magicLink';
import { readCodeInput } from '../auth/signInFlow';
import { useSession } from '../state/session';
import { useTheme } from '../theme/ThemeProvider';
import { font, radius, space } from '../theme/tokens';
import { Button, TextField } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { Sheet } from '../ui/layout';
import { Text } from '../ui/Text';
import { DELETED_ITEMS, emailMatches, type DeleteStep } from './deletion';

/**
 * Settings → Delete account: what goes, type your email, then the 6-digit code from the email deletes the account
 * for good. Afterwards this device signs out and the sign-in screen says the account was deleted.
 */
export function DeleteAccountSheet({ visible, onClose }: { visible: boolean; onClose(): void }) {
  const { c } = useTheme();
  const s = useSession();
  const account = s.profile?.email ?? null;
  const [step, setStep] = React.useState<DeleteStep>('explain');
  const [email, setEmail] = React.useState('');
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  // The server checks the address too; without a remembered one, any valid address can be tried.
  const canSend = account ? emailMatches(email, account) : isEmail(email);

  React.useEffect(() => {
    if (!visible) return;
    setStep('explain');
    setEmail('');
    setCode('');
    setErr(null);
  }, [visible]);

  const run = async (fn: () => Promise<void>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const sendCode = () =>
    void run(async () => {
      await s.startDeleteAccount(email);
      setStep('code');
    });

  const confirm = (value = code) =>
    void run(async () => {
      await s.deleteAccount(value);
      onClose();
      router.replace({ pathname: '/sign-in', params: { deleted: '1' } });
    });

  const onCode = (text: string) => {
    const r = readCodeInput(text);
    const digits = r.kind === 'code' ? r.code : r.kind === 'partial' ? r.digits : '';
    setCode(digits);
    if (err) setErr(null);
  };

  const codeStyle: TextStyle = {
    color: c.ink,
    fontFamily: font.mono,
    fontSize: 26,
    lineHeight: 32,
    letterSpacing: 10,
    textAlign: 'center',
    paddingVertical: 10,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null),
  };

  const footer =
    step === 'explain' ? (
      <>
        <Button label="Cancel" variant="ghost" onPress={onClose} />
        <Button label="Continue" variant="danger" onPress={() => setStep('email')} />
      </>
    ) : step === 'email' ? (
      <>
        <Button label="Back" variant="ghost" onPress={() => setStep('explain')} disabled={busy} />
        <Button label="Email me a code" variant="danger" loading={busy} disabled={!canSend} onPress={sendCode} />
      </>
    ) : (
      <>
        <Button label="Cancel" variant="ghost" onPress={onClose} disabled={busy} />
        <Button label="Delete my account" variant="destructive" loading={busy} disabled={code.length !== 6} onPress={() => confirm()} />
      </>
    );

  return (
    <Sheet visible={visible} onClose={busy ? () => undefined : onClose} title="Delete your account?" width={480} footer={<View style={styles.footer}>{footer}</View>}>
      {step === 'explain' ? (
        <View style={{ gap: space.md }}>
          <Text tone="muted">This deletes your qalm account and everything in it, on every device, for good. It can't be undone.</Text>
          <View style={[styles.list, { backgroundColor: c.badSoft, borderColor: c.line }]}>
            {DELETED_ITEMS.map((item) => (
              <View key={item} style={styles.item}>
                <Icon name="trash-2" size={14} color={c.bad} />
                <Text variant="small" style={{ color: c.ink2, flex: 1 }}>
                  {item}
                </Text>
              </View>
            ))}
          </View>
          <Text variant="meta">
            Want a copy first? Open a notebook and export it as PDF or a .qalm backup. Notebooks you made on this device without signing in stay on
            this device.
          </Text>
        </View>
      ) : step === 'email' ? (
        <View style={{ gap: space.md }}>
          <Text tone="muted">
            To confirm, type the email for this account. We'll send a 6-digit code to it.
          </Text>
          <TextField
            value={email}
            onChangeText={(v) => {
              setEmail(v);
              if (err) setErr(null);
            }}
            placeholder={account ?? 'you@example.com'}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            autoFocus
            icon="mail"
            onSubmitEditing={() => canSend && sendCode()}
            accessibilityLabel="Your account's email"
          />
          {email && !canSend ? (
            <Text variant="meta" tone="faint">
              Type the address you sign in with.
            </Text>
          ) : null}
        </View>
      ) : (
        <View style={{ gap: space.md }}>
          <Text tone="muted">
            We sent a code to{' '}
            <Text variant="bodyStrong" style={{ color: c.ink }}>
              {account}
            </Text>
            . Enter it to delete your account for good.
          </Text>
          <View style={[styles.codeBox, { backgroundColor: c.surface, borderColor: err ? c.bad : c.line }]}>
            <TextInput
              value={code}
              onChangeText={onCode}
              placeholder="000000"
              placeholderTextColor={c.line}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              autoFocus
              onSubmitEditing={() => code.length === 6 && confirm()}
              accessibilityLabel="6-digit deletion code from the email"
              style={codeStyle}
            />
          </View>
          <Text variant="meta" tone="faint">
            The code expires in 15 minutes. It's not a sign-in code.
          </Text>
        </View>
      )}
      {err ? (
        <View style={[styles.err, { backgroundColor: c.badSoft, borderColor: c.line }]}>
          <Icon name="alert-circle" size={16} color={c.bad} />
          <Text variant="label" style={{ color: c.bad, flex: 1 }} accessibilityRole="alert">
            {err}
          </Text>
        </View>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, flex: 1 },
  list: { gap: 10, padding: space.md, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  codeBox: { borderRadius: radius.control, borderWidth: 1 },
  err: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: space.md, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth },
});
