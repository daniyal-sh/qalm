import * as React from 'react';
import { Modal, Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { radius, shadow2 } from '../theme/tokens';
import { pendingConfirm, settleConfirm, subscribeConfirm } from './confirm';
import { Button } from './controls';
import { Text } from './Text';

/** The in-app confirm dialog behind `confirm()`: a solid surface with Cancel and a destructive action. */
export function ConfirmHost() {
  const { c } = useTheme();
  const win = useWindowDimensions();
  const pending = React.useSyncExternalStore(subscribeConfirm, pendingConfirm, pendingConfirm);
  // iOS can't present a modal while another (the menu or popover that asked) is still dismissing: wait a beat.
  const [req, setReq] = React.useState(pending);
  React.useEffect(() => {
    if (!pending || Platform.OS !== 'ios') return setReq(pending);
    const t = setTimeout(() => setReq(pending), 350);
    return () => clearTimeout(t);
  }, [pending]);
  return (
    <Modal visible={!!req} transparent animationType="fade" onRequestClose={() => settleConfirm(false)} supportedOrientations={['portrait', 'landscape']}>
      <View style={styles.wrap}>
        <Pressable accessibilityLabel="Cancel" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.32)' }]} onPress={() => settleConfirm(false)} />
        {req ? (
          <View
            accessibilityRole="alert"
            accessibilityViewIsModal
            style={[styles.card, shadow2, { width: Math.min(400, win.width - 32), backgroundColor: c.surface, borderColor: c.line }]}
          >
            <Text variant="section">{req.title}</Text>
            {req.body ? <Text tone="muted">{req.body}</Text> : null}
            <View style={styles.actions}>
              <Button label="Cancel" onPress={() => settleConfirm(false)} grow={win.width < 420} />
              <Button label={req.action} variant="destructive" onPress={() => settleConfirm(true)} grow={win.width < 420} />
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: { borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth, padding: 20, gap: 10 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 10 },
});
