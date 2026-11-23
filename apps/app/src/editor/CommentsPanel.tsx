import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { relativeTime } from '../library/actions';
import { useTheme } from '../theme/ThemeProvider';
import { radius } from '../theme/tokens';
import { Avatar, Button, IconButton, Segmented, TextField } from '../ui/controls';
import { EmptyState } from '../ui/layout';
import { Text } from '../ui/Text';
import { commentRows, type CommentFilter, type CommentRow } from './CommentsPanel.logic';
import type { PageData } from './context';
import { lineQuote } from './view';

function Card({ row, active, onSelect, onJump }: { row: CommentRow; active: boolean; onSelect(): void; onJump(): void }) {
  const { c } = useTheme();
  const { comment: cm, data } = row;
  const [reply, setReply] = React.useState<string | null>(null);
  const agent = cm.author.kind === 'agent';
  const quote = lineQuote(data.lines, cm.lineKey);
  const hasLine = data.lines.some((l) => l.key === cm.lineKey);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onSelect}
      style={[
        styles.card,
        {
          backgroundColor: agent ? c.assistantSoft : c.surface,
          borderColor: active ? (agent ? c.assistant : c.accent) : agent ? c.assistantLine : c.line,
        },
      ]}
    >
      <View style={styles.head}>
        <Avatar name={cm.author.name} kind={cm.author.kind} size={26} />
        <View style={{ flex: 1 }}>
          <Text variant="label" numberOfLines={1}>
            {cm.author.name}
            {agent ? <Text variant="meta" tone="assistant">{'  via MCP'}</Text> : null}
          </Text>
          <Text variant="meta" tone="faint">
            Page {data.index + 1} · {relativeTime(cm.createdAt)}
          </Text>
        </View>
      </View>
      <Text variant="meta" tone="muted" numberOfLines={2} style={{ fontStyle: 'italic' }}>
        {quote ? `“${quote}”` : hasLine ? 'Handwritten line' : 'The line was erased'}
      </Text>
      <Text>{cm.text}</Text>
      {cm.replies.map((r, i) => (
        <View key={i} style={[styles.reply, { borderLeftColor: r.author.kind === 'agent' ? c.assistantLine : c.accentLine }]}>
          <Text variant="meta" tone="muted">
            {r.author.name} · {relativeTime(r.at)}
          </Text>
          <Text variant="body">{r.text}</Text>
        </View>
      ))}
      {reply !== null ? (
        <View style={{ gap: 8 }}>
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
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <Button label="Reply" size="sm" variant="ghost" icon="corner-up-left" onPress={() => setReply('')} />
          {!cm.resolved ? <Button label="Resolve" size="sm" variant="ghost" icon="check" onPress={() => data.page.resolveComment(cm.id)} /> : null}
          {hasLine ? <Button label="Show" size="sm" variant="ghost" icon="crosshair" onPress={onJump} /> : null}
        </View>
      )}
    </Pressable>
  );
}

export function CommentsPanel({
  pages,
  activeId,
  onSelect,
  onJump,
  onClose,
}: {
  pages: Map<string, PageData>;
  activeId: string | null;
  onSelect(id: string | null): void;
  onJump(pageId: string): void;
  onClose(): void;
}) {
  const { c } = useTheme();
  const [filter, setFilter] = React.useState<CommentFilter>('open');
  const rows = commentRows(pages, filter);
  return (
    <View style={[styles.panel, { backgroundColor: c.surface, borderLeftColor: c.line }]}>
      <View style={styles.top}>
        <Text variant="section" style={{ flex: 1 }}>
          Comments
        </Text>
        <IconButton icon="x" label="Close comments" size={36} onPress={onClose} />
      </View>
      <View style={{ paddingHorizontal: 12 }}>
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
      <ScrollView contentContainerStyle={{ padding: 12, gap: 10, flexGrow: 1 }}>
        {rows.length ? (
          rows.map((r) => (
            <Card
              key={r.comment.id}
              row={r}
              active={r.comment.id === activeId}
              onSelect={() => onSelect(r.comment.id === activeId ? null : r.comment.id)}
              onJump={() => {
                onSelect(r.comment.id);
                onJump(r.pageId);
              }}
            />
          ))
        ) : (
          <EmptyState
            icon="message-square"
            title={filter === 'resolved' ? 'Nothing resolved yet' : 'No comments here'}
            body="Connected agents pin comments next to your lines. They can read and comment, but never change your ink."
          />
        )}
      </ScrollView>
      <View style={[styles.foot, { borderTopColor: c.line2, backgroundColor: c.surface2 }]}>
        <Text variant="meta" tone="muted">
          Showing comments on the pages around where you are.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, width: 340, maxWidth: '100%', borderLeftWidth: StyleSheet.hairlineWidth },
  top: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 6, height: 56 },
  card: { borderRadius: radius.panel, borderWidth: 1, padding: 12, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  reply: { borderLeftWidth: 2, paddingLeft: 10, gap: 2 },
  foot: { paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
});
