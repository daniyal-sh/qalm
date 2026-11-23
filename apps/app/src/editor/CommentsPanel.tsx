import { anchorInkRemoved, type Comment } from '@qalm/core';
import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { relativeTime } from '../library/actions';
import { useTheme } from '../theme/ThemeProvider';
import { indicatorStyleFor } from '../theme/scrollbars';
import { PANEL_HEADER, radius } from '../theme/tokens';
import { Avatar, Button, focusRing, IconButton, Segmented, TextField } from '../ui/controls';
import { EmptyState } from '../ui/layout';
import { Text } from '../ui/Text';
import { filterFor, filterRows, rowsInView, type CommentFilter, type CommentRow, type RowBox } from './CommentsPanel.logic';
import type { PageData } from './context';
import { lineQuote } from './view';

/** px width of the comments panel (docked or floating). */
export const PANEL_W = 344;

type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };

/** Where a thread sits, in words. A row from the index (page not loaded) only knows the line's reading. */
function whereText(row: CommentRow): { where: string; hasLine: boolean } {
  const { summary: t, data, comment: cm } = row;
  if (!data || !cm) return { where: t.quote ? `“${t.quote}”` : t.onSelection ? 'On a selection' : 'Handwritten line', hasLine: true };
  const quote = lineQuote(data.lines, cm.lineKey);
  const onSelection = !!cm.anchor || !!cm.anchorIds?.length;
  const hasLine = onSelection || data.lines.some((l) => l.key === cm.lineKey);
  const where = anchorInkRemoved(cm, data.items) ? 'Ink removed' : quote ? `“${quote}”` : onSelection ? 'On a selection' : hasLine ? 'Handwritten line' : 'The line was erased';
  return { where, hasLine };
}

/**
 * One thread. The card itself is not a control: its summary (author, where, first message) is the button that
 * focuses the thread, and Reply / Resolve / Show and the reply field are separate controls below it. A thread on a page
 * that isn't loaded shows its latest message; selecting it scrolls there, which loads the page and the full thread.
 */
function Card({ row, active, onSelect, onJump }: { row: CommentRow; active: boolean; onSelect(): void; onJump(): void }) {
  const { c } = useTheme();
  const t = row.summary;
  const agent = t.author.kind === 'agent';
  const { where, hasLine } = whereText(row);
  const accent = agent ? c.assistant : c.accent;
  const replies = t.kinds.length - 1;
  return (
    <View style={[styles.card, { backgroundColor: agent ? c.assistantSoft : c.surface, borderColor: active ? accent : agent ? c.assistantLine : c.line }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t.author.name}${agent ? ', AI agent' : ''}, page ${row.index + 1}: ${t.text}`}
        accessibilityHint={row.data ? (hasLine ? 'Highlights it on the page' : undefined) : 'Goes to its page'}
        accessibilityState={{ selected: active }}
        onPress={onSelect}
        style={(s) => {
          const st = s as PressState;
          return [styles.summary, (st.hovered || st.pressed) && { backgroundColor: c.soft }, focusRing(c, st.focused)];
        }}
      >
        <View style={styles.head}>
          <Avatar name={t.author.name} kind={t.author.kind} size={26} />
          <View style={{ flex: 1 }}>
            <Text variant="label" numberOfLines={1}>
              {t.author.name}
              {agent ? <Text variant="meta" tone="assistant">{'  AI agent'}</Text> : null}
            </Text>
            <Text variant="meta" tone="faint">
              Page {row.index + 1} · {relativeTime(t.createdAt)}
            </Text>
          </View>
        </View>
        <Text variant="meta" tone="muted" numberOfLines={2} style={{ fontStyle: 'italic' }}>
          {where}
        </Text>
        <Text numberOfLines={row.comment ? undefined : 3}>{row.comment ? row.comment.text : t.text}</Text>
      </Pressable>
      {row.comment && row.data ? (
        <Thread comment={row.comment} data={row.data} hasLine={hasLine} onJump={onJump} />
      ) : (
        <>
          {replies > 0 ? (
            <View style={[styles.reply, { borderLeftColor: t.last.author.kind === 'agent' ? c.assistantLine : c.accentLine }]}>
              <Text variant="meta" tone="muted">
                {replies > 1 ? `${replies} replies · latest from ` : ''}
                {t.last.author.name} · {relativeTime(t.last.at)}
              </Text>
              <Text variant="body" numberOfLines={3}>
                {t.last.text}
              </Text>
            </View>
          ) : null}
          <View style={styles.actionRow}>
            <Button label={`Go to page ${row.index + 1}`} size="sm" variant="ghost" icon="arrow-right" onPress={onJump} />
          </View>
        </>
      )}
    </View>
  );
}

/** Replies and the Reply / Resolve / Show controls of a thread on a loaded page. */
function Thread({ comment: cm, data, hasLine, onJump }: { comment: Comment; data: PageData; hasLine: boolean; onJump(): void }) {
  const { c } = useTheme();
  const [reply, setReply] = React.useState<string | null>(null);
  return (
    <>
      {cm.replies.map((r, i) => (
        <View key={i} style={[styles.reply, { borderLeftColor: r.author.kind === 'agent' ? c.assistantLine : c.accentLine }]}>
          <Text variant="meta" tone="muted">
            {r.author.name} · {relativeTime(r.at)}
          </Text>
          <Text variant="body">{r.text}</Text>
        </View>
      ))}
      {reply !== null ? (
        <View style={styles.actions}>
          <TextField value={reply} onChangeText={setReply} placeholder="Reply" autoFocus multiline accessibilityLabel="Reply" />
          <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
            <Button label="Cancel" size="sm" variant="ghost" onPress={() => setReply(null)} />
            <Button
              label="Send"
              size="sm"
              variant="primary"
              disabled={!reply.trim()}
              onPress={() => {
                data.page.replyToComment(cm.id, { kind: 'user', name: 'You' }, reply.trim());
                setReply(null);
              }}
            />
          </View>
        </View>
      ) : (
        // One row: Reply and Resolve on the left, Show on the right.
        <View style={styles.actionRow}>
          <Button label="Reply" size="sm" variant="ghost" icon="corner-up-left" onPress={() => setReply('')} />
          {!cm.resolved ? <Button label="Resolve" size="sm" variant="ghost" icon="check" onPress={() => data.page.resolveComment(cm.id)} /> : null}
          {hasLine ? (
            <View style={{ marginLeft: 'auto' }}>
              <Button label="Show" accessibilityLabel="Show on page" size="sm" variant="ghost" icon="crosshair" onPress={onJump} />
            </View>
          ) : null}
        </View>
      )}
    </>
  );
}

export function CommentsPanel({
  threads,
  activeId,
  indexing,
  onSelect,
  onJump,
  onClose,
  onVisible,
}: {
  /** Every thread in the notebook (`threadRows`). */
  threads: readonly CommentRow[];
  activeId: string | null;
  /** Older pages are still being indexed (an older notebook's first visit). */
  indexing: boolean;
  onSelect(id: string | null): void;
  onJump(pageId: string): void;
  onClose(): void;
  /** The threads whose cards are on screen in the panel (sorted ids; for read state). */
  onVisible(ids: string[]): void;
}) {
  const { c, scheme } = useTheme();
  const [filter, setFilter] = React.useState<CommentFilter>('open');
  const rows = filterRows(threads, filter);
  const openCount = filterRows(threads, 'open').length;
  // When a thread becomes active, or is resolved while active, switch to a tab that lists it (checked against every
  // thread, not just this tab's rows). Only on that change, so the tabs stay free to switch afterwards.
  const active = activeId ? threads.find((r) => r.summary.id === activeId)?.summary : undefined;
  const activeKey = active ? `${active.id}:${active.resolved}` : '';
  const lastActiveKey = React.useRef('');
  React.useEffect(() => {
    if (activeKey === lastActiveKey.current) return;
    lastActiveKey.current = activeKey;
    if (active) setFilter((f) => filterFor(active, f));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);
  // Focusing a thread (a margin card or pin) scrolls it into view.
  const scroll = React.useRef<React.ComponentRef<typeof ScrollView>>(null);
  const boxes = React.useRef(new Map<string, RowBox>());
  const view = React.useRef({ y: 0, h: 0 });
  const scrolledTo = React.useRef<string | null>(null);
  const scrollToActive = React.useCallback(() => {
    if (!activeId || scrolledTo.current === activeId) return;
    const b = boxes.current.get(activeId);
    if (!b) return;
    scrolledTo.current = activeId;
    scroll.current?.scrollTo({ y: Math.max(0, b.y - 12), animated: true });
  }, [activeId]);
  // Which cards are on screen, reported when that changes.
  const shown = React.useRef<string | null>(null);
  const onVisibleRef = React.useRef(onVisible);
  onVisibleRef.current = onVisible;
  const ids = rows.map((r) => r.summary.id).join(',');
  const report = React.useCallback(() => {
    const live = new Set(ids ? ids.split(',') : []);
    for (const id of [...boxes.current.keys()]) if (!live.has(id)) boxes.current.delete(id);
    const vis = rowsInView(boxes.current, view.current.y, view.current.h);
    const key = vis.join(',');
    if (key === shown.current) return;
    shown.current = key;
    onVisibleRef.current(vis);
  }, [ids]);
  React.useEffect(() => {
    if (!activeId) scrolledTo.current = null;
    scrollToActive();
    report();
  });
  React.useEffect(() => () => onVisibleRef.current([]), []);
  return (
    <View style={[styles.panel, { backgroundColor: c.surface, borderLeftColor: c.line }]}>
      {/* The same header and filter row as the Pages sidebar. */}
      <View style={styles.top}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="section" numberOfLines={1} accessibilityRole="header">
            Comments
          </Text>
          <Text variant="meta" tone="faint" numberOfLines={1}>
            {openCount ? `${openCount} open` : 'None open'}
          </Text>
        </View>
        <IconButton icon="x" label="Close comments" size={36} onPress={onClose} />
      </View>
      <View style={[styles.filter, { borderBottomColor: c.line2 }]}>
        <Segmented<CommentFilter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'ai', label: 'AI' },
            { value: 'resolved', label: 'Resolved' },
          ]}
        />
      </View>
      <ScrollView
        ref={scroll}
        indicatorStyle={indicatorStyleFor(scheme)}
        style={{ flex: 1 }}
        contentContainerStyle={styles.list}
        scrollEventThrottle={100}
        onScroll={(e) => {
          view.current.y = e.nativeEvent.contentOffset.y;
          report();
        }}
        onLayout={(e) => {
          view.current.h = e.nativeEvent.layout.height;
          report();
        }}
      >
        {rows.length ? (
          rows.map((r) => (
            <View
              key={r.summary.id}
              onLayout={(e) => {
                const { y, height } = e.nativeEvent.layout;
                boxes.current.set(r.summary.id, { y, h: height });
                if (r.summary.id === activeId) scrollToActive();
                report();
              }}
            >
              <Card
                row={r}
                active={r.summary.id === activeId}
                onSelect={() => {
                  // A thread on a page that isn't loaded: go there (which loads it) and focus the thread.
                  if (!r.data) {
                    onSelect(r.summary.id);
                    onJump(r.pageId);
                  } else onSelect(r.summary.id === activeId ? null : r.summary.id);
                }}
                onJump={() => {
                  onSelect(r.summary.id);
                  onJump(r.pageId);
                }}
              />
            </View>
          ))
        ) : (
          <EmptyState
            icon="message-square"
            title={filter === 'resolved' ? 'Nothing resolved yet' : 'No comments here'}
            body="Select something with the lasso to comment on it or ask about it. Connected agents can read and comment, but never change your ink."
          />
        )}
      </ScrollView>
      {indexing ? (
        <View style={[styles.foot, { borderTopColor: c.line2, backgroundColor: c.surface2 }]}>
          <Text variant="meta" tone="muted">
            Finding comments on older pages…
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, width: PANEL_W, maxWidth: '100%', minWidth: 0, overflow: 'hidden', borderLeftWidth: StyleSheet.hairlineWidth },
  top: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingLeft: 16, paddingRight: 8, ...PANEL_HEADER },
  filter: { paddingHorizontal: 12, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  list: { padding: 12, gap: 12, flexGrow: 1 },
  card: { borderRadius: radius.panel, borderWidth: 1, padding: 6, gap: 4 },
  summary: { borderRadius: radius.control, paddingHorizontal: 10, paddingVertical: 8, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  reply: { borderLeftWidth: 2, paddingLeft: 10, marginLeft: 10, marginRight: 4, marginVertical: 2, gap: 2 },
  actions: { paddingHorizontal: 4, gap: 8 },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 0 },
  foot: { paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
});
