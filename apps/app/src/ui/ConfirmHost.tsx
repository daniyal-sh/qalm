import * as React from 'react';
import { Animated, Modal, Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { riseStyle, usePresence } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';
import { motion, radius, shadow2, space } from '../theme/tokens';
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
  const { mounted, progress } = usePresence(!!req, motion.base, motion.fast);
  // Keep the text on screen while the dialog animates out.
  const lastReq = React.useRef(req);
  if (req) lastReq.current = req;
  const shown = req ?? lastReq.current;
  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={() => settleConfirm(false)} supportedOrientations={['portrait', 'landscape']}>
      <View style={styles.wrap}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim, opacity: progress }]}>
          <Pressable accessibilityLabel="Cancel" style={StyleSheet.absoluteFill} onPress={() => settleConfirm(false)} />
        </Animated.View>
        {shown ? (
          <Animated.View
            accessibilityRole="alert"
            accessibilityViewIsModal
            style={[riseStyle(progress, { scale: true }), styles.card, shadow2, { width: Math.min(400, win.width - 32), backgroundColor: c.surface, borderColor: c.line }]}
          >
            <Text variant="section">{shown.title}</Text>
            {shown.body ? <Text tone="muted">{shown.body}</Text> : null}
            <View style={styles.actions}>
              <Button label="Cancel" onPress={() => settleConfirm(false)} grow={win.width < 420} />
              <Button label={shown.action} variant="destructive" onPress={() => settleConfirm(true)} grow={win.width < 420} />
            </View>
          </Animated.View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: { borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth, padding: space.xl, gap: space.sm },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm, marginTop: space.md },
});
