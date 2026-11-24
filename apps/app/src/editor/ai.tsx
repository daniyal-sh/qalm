/** Live AI in the editor: the Play / Pause AI control with who is following, and comment cards in the page margin. */
import type { Comment } from '@qalm/core';
import * as React from 'react';
import { Animated, AppState, Platform, Pressable, StyleSheet, View } from 'react-native';

import { getPresence, presenceCan, presenceNames, type Presence } from '../api/ai';
import type { TokenManager } from '../auth/tokens';
import type { SyncProvider } from '../sync/provider';
import { useTheme } from '../theme/ThemeProvider';
import { radius } from '../theme/tokens';
import { Avatar } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { Text } from '../ui/Text';
import { AiLive } from './aiLive';

const POLL_MS = 8000;
const NATIVE_DRIVER = Platform.OS !== 'web';

/**
 * Polls GET /ai/presence while the editor is open, signed in, and AI access is on: who is following, and whether
 * any device is playing. `bump` changes on Play / Pause: re-poll soon, and don't show a stale "live" meanwhile.
 */
export function usePresence(tm: TokenManager | null, notebookId: string, enabled: boolean, bump = 0): { agents: Presence['agents']; live: boolean } {
  const [p, setP] = React.useState<{ agents: Presence['agents']; live: boolean }>(NONE);
  React.useEffect(() => {
    if (!tm || !enabled) {
      setP(NONE);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const r = await getPresence(tm, notebookId);
        if (alive) setP(r.aiAccess ? { agents: r.agents, live: r.live === true } : NONE);
      } catch {
        // Offline, or the session expired: don't keep claiming an agent is following along.
        if (alive) setP((x) => (x.agents.length || x.live ? NONE : x));
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    if (bump) {
      setP((x) => ({ ...x, live: false }));
      timer = setTimeout(tick, 700);
    } else void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [tm, notebookId, enabled, bump]);
  return p;
}

const NONE = { agents: [] as Presence['agents'], live: false };

/**
 * Play / Pause AI on this device for the open notebook (see aiLive.ts). Starts paused; leaving the app (another app
 * in front, the tab hidden, the window minimized; unless held, see `holdWhileBackgrounded`), closing the notebook, AI
 * access going off or signing out stops it.
 */
export function useAiLive(
  provider: SyncProvider | null,
  enabled: boolean,
): {
  playing: boolean;
  /** A Pause pressed offline that hasn't reached the server yet. */
  pausePending: boolean;
  play(): void;
  /** False when it couldn't go out yet: queued until the socket is back. */
  pause(): boolean;
  /** Keep sharing while the app is in the background (e.g. a running Lecture recording); returns the release. */
  holdWhileBackgrounded(reason: string): () => void;
} {
  const [ctl, setCtl] = React.useState<AiLive | null>(null);
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    if (!provider || !enabled) return;
    const c = new AiLive(provider);
    const off = c.onChange(force);
    setCtl(c);
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'background') c.background();
      else if (st === 'active') c.foreground();
    });
    return () => {
      sub.remove();
      off();
      c.destroy();
      setCtl(null);
    };
  }, [provider, enabled]);
  // `force` re-renders on every change, so `playing` here is always current.
  return {
    playing: !!ctl?.playing,
    pausePending: !!ctl?.pausePending,
    play: () => ctl?.play(),
    pause: () => ctl?.pause() ?? false,
    holdWhileBackgrounded: (reason) => ctl?.holdWhileBackgrounded(reason) ?? (() => undefined),
  };
}

/**
 * Calls `onRead(ids)` once threads have stayed in `ids` (those on screen and unread) for `ms`. A thread that leaves
 * the screen starts over when it comes back.
 */
export function useReadAfterDwell(ids: readonly string[], ms: number, onRead: (ids: string[]) => void): void {
  const since = React.useRef(new Map<string, number>());
  const cb = React.useRef(onRead);
  cb.current = onRead;
  const [tick, setTick] = React.useState(0);
  const key = [...ids].sort().join(',');
  React.useEffect(() => {
    const m = since.current;
    const now = Date.now();
    const cur = new Set(key ? key.split(',') : []);
    for (const id of [...m.keys()]) if (!cur.has(id)) m.delete(id);
    for (const id of cur) if (!m.has(id)) m.set(id, now);
    if (!m.size) return;
    const wait = Math.max(0, Math.min(...m.values()) + ms - now);
    const t = setTimeout(() => {
      const at = Date.now();
      const ready = [...m].filter(([, s]) => at - s >= ms).map(([id]) => id);
      for (const id of ready) m.delete(id);
      if (ready.length) cb.current(ready);
      setTick((x) => x + 1);
    }, wait);
    return () => clearTimeout(t);
  }, [key, ms, tick]);
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
 * The header's Play / Pause AI control (only shown while AI access is on). Paused (neutral): "AI paused", tap to
 * play. Live (assistant blue, the only time it's blue): "AI live", "AI live · Claude" with a connected agent, or
 * "Claude is thinking…" after an Ask; tap to pause on every device.
 */
export function AiControl({
  agents,
  live,
  here,
  thinking,
  compact,
  onPlay,
  onPause,
}: {
  agents: Presence['agents'];
  /** Shared with agents right now (this device or another one is playing). */
  live: boolean;
  /** This device is the one playing. */
  here: boolean;
  thinking: boolean;
  compact: boolean;
  onPlay(): void;
  onPause(): void;
}) {
  const { c } = useTheme();
  const names = presenceNames(agents.map((a) => a.name));
  const label = !live ? 'AI paused' : thinking && names ? `${names} is thinking…` : names && !compact ? `AI live · ${names}` : 'AI live';
  const fg = live ? c.assistant : c.ink2;
  const what = !live
    ? 'Agents can’t read this notebook. Play to share it while it’s open here.'
    : `${here ? '' : 'Playing on another device. '}${names ? `${names} can ${presenceCan(agents).toLowerCase()}.` : 'No agent connected yet.'} Never changes your ink.`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${live ? 'Pause AI' : 'Play AI'}`}
      accessibilityHint={what}
      onPress={live ? onPause : onPlay}
      {...((Platform.OS === 'web' ? { title: `${live ? 'Pause AI' : 'Play AI'}: ${what}` } : {}) as object)}
      style={(s) => [
        styles.pill,
        { backgroundColor: live ? c.assistantSoft : c.surface2, borderColor: live ? c.assistantLine : c.line },
        ((s as { hovered?: boolean }).hovered || s.pressed) && { borderColor: fg },
      ]}
    >
      <Icon name={live ? 'pause' : 'play'} size={12} color={fg} />
      {live ? <Dot color={fg} on={thinking} /> : null}
      <Text variant="meta" numberOfLines={1} style={{ color: fg, fontWeight: '600', maxWidth: compact ? 120 : 260, flexShrink: 1 }}>
        {label}
      </Text>
    </Pressable>
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
  unread,
  thinking,
  onPress,
}: {
  comment: Comment;
  top: number;
  width: number;
  active: boolean;
  /** It has agent entries the student hasn't read. */
  unread: boolean;
  thinking: boolean;
  onPress(): void;
}) {
  const { c } = useTheme();
  const last = comment.replies[comment.replies.length - 1];
  const latest = last ?? { author: comment.author, text: comment.text };
  const agent = latest.author.kind === 'agent';
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
          {thinking ? (
            <Text variant="meta" style={{ color: c.assistant }} numberOfLines={1}>
              Thinking…
            </Text>
          ) : unread ? (
            <View style={[styles.dot, { backgroundColor: c.assistant }]} accessibilityLabel="New" />
          ) : null}
        </View>
        <Text variant="meta" tone="ink" numberOfLines={2}>
          {latest.text}
        </Text>
      </Pressable>
    </AppearIn>
  );
}

const styles = StyleSheet.create({
  // Shrinks (its label ellipsizes) instead of pushing past the title column onto Undo / Redo on a phone.
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 26, paddingHorizontal: 10, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, flexShrink: 1, minWidth: 0 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  card: { borderRadius: radius.control, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 7, gap: 2, overflow: 'hidden' },
});
