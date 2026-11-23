/** Live agent presence in the editor: the "following along" pill and its popover, and comment cards in the page margin. */
import type { Comment, Notebook } from '@qalm/core';
import * as React from 'react';
import { Animated, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';

import { getPresence, presenceCan, presenceNames, type Presence } from '../api/ai';
import type { TokenManager } from '../auth/tokens';
import { useTheme } from '../theme/ThemeProvider';
import { radius, shadow2 } from '../theme/tokens';
import { confirm } from '../ui/confirm';
import { Avatar, Button } from '../ui/controls';
import { Text } from '../ui/Text';
import { unreadIn, type SeenThreads } from './ai.logic';

const POLL_MS = 8000;
const NATIVE_DRIVER = Platform.OS !== 'web';

/** Polls GET /ai/presence while the editor is open, signed in, and AI access is on. */
export function usePresence(tm: TokenManager | null, notebookId: string, enabled: boolean): Presence['agents'] {
  const [agents, setAgents] = React.useState<Presence['agents']>([]);
  React.useEffect(() => {
    if (!tm || !enabled) {
      setAgents([]);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const p = await getPresence(tm, notebookId);
        if (alive) setAgents(p.aiAccess ? p.agents : []);
      } catch {
        /* offline or signed out: keep the last answer */
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [tm, notebookId, enabled]);
  return agents;
}

/** A dot that pulses while `on`. */
function Dot({ color, on }: { color: string; on: boolean }) {
  const v = React.useRef(new Animated.Value(1)).current;
  React.useEffect(() => {
    if (!on) {
      v.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 0.25, duration: 600, useNativeDriver: NATIVE_DRIVER }),
        Animated.timing(v, { toValue: 1, duration: 600, useNativeDriver: NATIVE_DRIVER }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [on, v]);
  return <Animated.View style={[styles.dot, { backgroundColor: color, opacity: v }]} />;
}

/**
 * "Claude is following along" (assistant blue, with a dot), "… is thinking…" after an Ask, or "Sharing paused".
 * Tapping it opens what the agent can do, Pause/Resume sharing and Stop.
 */
export function PresencePill({
  agents,
  notebook,
  paused,
  thinking,
  compact,
}: {
  agents: Presence['agents'];
  notebook: Notebook;
  paused: boolean;
  thinking: boolean;
  compact: boolean;
}) {
  const { c } = useTheme();
  const [anchor, setAnchor] = React.useState<{ x: number; y: number } | null>(null);
  const ref = React.useRef<React.ComponentRef<typeof Pressable>>(null);
  if (!agents.length && !paused) return null;
  const names = presenceNames(agents.map((a) => a.name)) || 'Your agent';
  const label = paused ? 'Sharing paused' : thinking ? `${names} is thinking…` : compact ? names : `${names} is following along`;
  const fg = paused ? c.warn : c.assistant;
  const open = () => ref.current?.measureInWindow((x, y, _w, h) => setAnchor({ x, y: y + h + 6 }));
  return (
    <>
      <Pressable
        ref={ref}
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={open}
        style={(s) => [
          styles.pill,
          { backgroundColor: paused ? c.warnSoft : c.assistantSoft, borderColor: paused ? c.line : c.assistantLine },
          ((s as { hovered?: boolean }).hovered || s.pressed) && { borderColor: fg },
        ]}
      >
        <Dot color={fg} on={thinking && !paused} />
        <Text variant="meta" numberOfLines={1} style={{ color: fg, fontWeight: '600', maxWidth: compact ? 120 : 260 }}>
          {label}
        </Text>
      </Pressable>
      <Modal visible={!!anchor} transparent animationType="none" onRequestClose={() => setAnchor(null)} supportedOrientations={['portrait', 'landscape']}>
        <Pressable accessibilityLabel="Close" style={StyleSheet.absoluteFill} onPress={() => setAnchor(null)} />
        <View style={[styles.pop, shadow2, { left: Math.max(8, (anchor?.x ?? 0) - 40), top: anchor?.y ?? 0, backgroundColor: c.surface, borderColor: c.line }]}>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <Avatar name={agents[0]?.name ?? 'AI'} kind="agent" size={32} />
            <View style={{ flex: 1 }}>
              <Text variant="label">{paused ? 'Sharing is paused' : `${names} is following along`}</Text>
              <Text variant="meta" tone="muted">
                {agents.length ? `Can ${presenceCan(agents).toLowerCase()}. Never changes your ink.` : 'No agent is following right now.'}
              </Text>
            </View>
          </View>
          <Text variant="meta" tone="muted">
            {paused
              ? 'Agents keep their access but get no updates and can’t read this notebook until you resume.'
              : 'Updates go out when you pause writing, tap Ask or comment.'}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
            <Button
              label="Stop"
              size="sm"
              variant="ghost"
              icon="x-circle"
              onPress={() => {
                setAnchor(null);
                confirm('Turn off AI access?', 'Agents can’t see this notebook until you turn it back on.', 'Turn off', () => notebook.setMeta({ aiAccess: false, aiPaused: false }));
              }}
            />
            <Button
              label={paused ? 'Resume sharing' : 'Pause sharing'}
              size="sm"
              variant="assistant"
              icon={paused ? 'play' : 'pause'}
              onPress={() => {
                setAnchor(null);
                notebook.setMeta({ aiPaused: !paused });
              }}
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

/** Fades and slides in once, when first shown. */
function AppearIn({ children, style }: { children: React.ReactNode; style: object }) {
  const v = React.useRef(new Animated.Value(0)).current;
  React.useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 260, useNativeDriver: NATIVE_DRIVER }).start();
  }, [v]);
  return <Animated.View style={[style, { opacity: v, transform: [{ translateX: v.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] }]}>{children}</Animated.View>;
}

export const MARGIN_CARD_H = 64;

/** One open thread in the page margin, next to its line. Tapping focuses it in the panel. */
export function MarginCard({
  comment,
  top,
  width,
  active,
  seen,
  thinking,
  onPress,
}: {
  comment: Comment;
  top: number;
  width: number;
  active: boolean;
  seen: SeenThreads;
  thinking: boolean;
  onPress(): void;
}) {
  const { c } = useTheme();
  const last = comment.replies[comment.replies.length - 1];
  const latest = last ?? { author: comment.author, text: comment.text };
  const agent = latest.author.kind === 'agent';
  const unread = unreadIn(comment, seen) > 0;
  const replies = comment.replies.length;
  return (
    <AppearIn style={{ position: 'absolute', top, left: 0, width }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Comment from ${latest.author.name}: ${latest.text}`}
        onPress={onPress}
        style={(s) => [
          styles.card,
          {
            height: MARGIN_CARD_H,
            backgroundColor: agent ? c.assistantSoft : c.surface,
            borderColor: active ? (agent ? c.assistant : c.accent) : agent ? c.assistantLine : c.line,
          },
          ((s as { hovered?: boolean }).hovered || s.pressed) && { borderColor: agent ? c.assistant : c.accent },
        ]}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Avatar name={latest.author.name} kind={latest.author.kind} size={18} />
          <Text variant="meta" numberOfLines={1} style={{ flex: 1, color: agent ? c.assistant : c.ink2, fontWeight: '600' }}>
            {latest.author.name}
            {replies ? <Text variant="meta" tone="faint">{`  · ${replies + 1}`}</Text> : null}
          </Text>
          {unread ? <View style={[styles.dot, { backgroundColor: c.assistant }]} accessibilityLabel="New" /> : null}
        </View>
        <Text variant="meta" tone="ink" numberOfLines={thinking ? 1 : 2}>
          {latest.text}
        </Text>
        {thinking ? (
          <Text variant="meta" style={{ color: c.assistant }} numberOfLines={1}>
            Thinking…
          </Text>
        ) : null}
      </Pressable>
    </AppearIn>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 26, paddingHorizontal: 10, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth },
  dot: { width: 7, height: 7, borderRadius: 4 },
  pop: { position: 'absolute', width: 320, maxWidth: '96%', padding: 14, gap: 10, borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth },
  card: { borderRadius: radius.control, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 7, gap: 2, overflow: 'hidden' },
});
