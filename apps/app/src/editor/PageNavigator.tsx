import type { PageInfo } from '@qalm/core';
import * as React from 'react';
import { FlatList, Image, PanResponder, PixelRatio, Platform, Pressable, StyleSheet, View, type GestureResponderEvent } from 'react-native';

import { indicatorStyleFor } from '../theme/scrollbars';
import { useTheme } from '../theme/ThemeProvider';
import { PANEL_HEADER, PAPER_SWATCH } from '../theme/tokens';
import { IconButton, Segmented } from '../ui/controls';
import { EmptyState, Menu, type MenuItem } from '../ui/layout';
import { Text } from '../ui/Text';
import {
  dropGap,
  moveIndex,
  NAV_GAP,
  NAV_LABEL_H,
  NAV_PAD,
  navEntries,
  thumbBox,
  navLayout,
  rowOf,
  type NavEntry,
  type NavFilter,
  type NavLayout,
  type NavMode,
} from './navigator.logic';
import type { Thumbnails } from './thumbnails';

export interface PageNavigatorProps {
  mode: NavMode;
  /** px width of the navigator */
  width: number;
  pages: PageInfo[];
  current: number;
  thumbs: Thumbnails;
  onJump(index: number): void;
  onClose(): void;
  onGoTo(): void;
  onMove(from: number, to: number): void;
  onDuplicate(index: number): void;
  onDelete(index: number): void;
  onBookmark(index: number): void;
  /** Change a page's paper (not offered for PDF pages). */
  onPaper?(index: number): void;
}

/** The thumbnail for a page: requested only while its cell is mounted (on screen), re-rendered a moment after it changes. */
function useThumbnail(thumbs: Thumbnails, info: PageInfo, width: number, priority: number): string | undefined {
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => thumbs.subscribe(info.id, force), [thumbs, info.id]);
  const e = thumbs.get(info.id);
  const stale = !e || e.stale;
  const prio = React.useRef(priority);
  prio.current = priority;
  React.useEffect(() => {
    if (!stale) return;
    let cancel = () => undefined as void;
    // A fresh request goes straight into the queue; a changed page waits until the writing pauses.
    const t = setTimeout(() => (cancel = thumbs.request(info, width, prio.current)), e ? 800 : 0);
    return () => {
      clearTimeout(t);
      cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thumbs, info.id, info.background, info.paper, info.paperColor, width, stale]);
  return e?.uri;
}

interface CellProps {
  entry: NavEntry;
  layout: NavLayout;
  current: boolean;
  priority: number;
  thumbs: Thumbnails;
  dragging: boolean;
  onPress(): void;
  onLongPress(e: GestureResponderEvent): void;
  onBookmark(): void;
  onMore(anchor: { x: number; y: number }): void;
}

/** A mouse or trackpad (not touch): page controls appear on hover / focus. On touch they're always there. */
const HOVER_POINTER =
  Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };

const Cell = React.memo(function Cell({ entry, layout, current, priority, thumbs, dragging, onPress, onLongPress, onBookmark, onMore }: CellProps) {
  const { c } = useTheme();
  const { info, index } = entry;
  const thumbW = Math.round(layout.cellW * Math.min(2, Math.max(1, PixelRatio.get())));
  const uri = useThumbnail(thumbs, info, thumbW, priority);
  const box = thumbBox(info.size, layout);
  const [hover, setHover] = React.useState(false);
  const [focus, setFocus] = React.useState(0);
  const controls = !HOVER_POINTER || hover || focus > 0;
  const focusProps = { onFocus: () => setFocus((n) => n + 1), onBlur: () => setFocus((n) => Math.max(0, n - 1)) };
  return (
    <View
      style={{ width: layout.cellW, height: layout.thumbH + NAV_LABEL_H, opacity: dragging ? 0.4 : 1 }}
      onPointerEnter={HOVER_POINTER ? () => setHover(true) : undefined}
      onPointerLeave={HOVER_POINTER ? () => setHover(false) : undefined}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Page ${index + 1}${info.bookmarked ? ', bookmarked' : ''}${current ? ', current page' : ''}`}
        accessibilityHint="Long-press to drag it somewhere else"
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={300}
        {...focusProps}
        style={{ height: layout.thumbH, alignItems: 'center', justifyContent: 'center' }}
      >
        {(s) => {
          const st = s as PressState;
          return (
            // The ring sits 2 px outside the page: accent for the current page, a hairline hint on hover.
            <View style={[styles.ring, { borderColor: current ? c.accent : st.hovered || st.focused ? c.line : 'transparent' }]}>
              <View style={[styles.thumb, { width: box.w, height: box.h, backgroundColor: PAPER_SWATCH[info.paperColor], borderColor: c.line }]}>
                {uri ? <Image source={{ uri }} style={{ width: '100%', height: '100%' }} resizeMode="contain" /> : null}
              </View>
            </View>
          );
        }}
      </Pressable>
      <View style={styles.label}>
        <View style={[styles.side, { opacity: controls || info.bookmarked ? 1 : 0 }]}>
          <IconButton
            icon="bookmark"
            label={info.bookmarked ? `Remove bookmark from page ${index + 1}` : `Bookmark page ${index + 1}`}
            size={28}
            color={info.bookmarked ? c.accentInk : c.faint}
            style={info.bookmarked ? { backgroundColor: c.accentSoft } : undefined}
            onPress={onBookmark}
            {...focusProps}
          />
        </View>
        <Text variant="meta" tone={current ? 'accent' : 'muted'} numberOfLines={1} style={{ flex: 1, textAlign: 'center', fontWeight: current ? '600' : undefined }}>
          {index + 1}
          {info.background.kind === 'pdf' ? ' · PDF' : ''}
        </Text>
        <View style={[styles.side, { opacity: controls ? 1 : 0 }]}>
          <IconButton
            icon="more-horizontal"
            label={`Page ${index + 1} options`}
            size={28}
            color={c.faint}
            onPress={(e) => onMore({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY })}
            {...focusProps}
          />
        </View>
      </View>
    </View>
  );
});

/**
 * The page navigator (GoodNotes-style): thumbnails of every page, as a sidebar on wide windows or a full-screen grid
 * on narrow ones. Tap to jump; long-press and drag to reorder; bookmark, duplicate and delete from each page's menu.
 * The list is virtualised and thumbnails render lazily, so it stays cheap with hundreds of pages.
 */
export function PageNavigator(props: PageNavigatorProps) {
  const { mode, width, pages, current, thumbs, onJump, onClose, onGoTo, onMove, onDuplicate, onDelete, onBookmark, onPaper } = props;
  const { c, scheme } = useTheme();
  const [filter, setFilter] = React.useState<NavFilter>('all');
  const [menu, setMenu] = React.useState<{ items: MenuItem[]; anchor: { x: number; y: number } } | null>(null);
  const entries = React.useMemo(() => navEntries(pages, filter), [pages, filter]);
  // Leave room for the web scrollbar, which takes width from the list.
  const layout = React.useMemo(() => navLayout(width - (Platform.OS === 'web' ? 14 : 0), mode, pages), [width, mode, pages]);
  const rows = React.useMemo(() => {
    const out: NavEntry[][] = [];
    for (let i = 0; i < entries.length; i += layout.columns) out.push(entries.slice(i, i + layout.columns));
    return out;
  }, [entries, layout.columns]);
  const bookmarks = React.useMemo(() => pages.filter((p) => p.bookmarked).length, [pages]);

  // ---- keep the current page in view ----
  const list = React.useRef<FlatList<NavEntry[]>>(null);
  const scrollY = React.useRef(0);
  const viewH = React.useRef(0);
  // The list's height once measured: the first scroll to the current page waits for it.
  const [measuredH, setMeasuredH] = React.useState(0);
  const touchedAt = React.useRef(0);
  const currentRow = React.useMemo(() => {
    const i = entries.findIndex((e) => e.index === current);
    return i < 0 ? -1 : rowOf(i, layout);
  }, [entries, current, layout]);
  React.useEffect(() => {
    if (currentRow < 0 || !viewH.current || Date.now() - touchedAt.current < 2000) return;
    const top = NAV_PAD + currentRow * layout.rowH;
    if (top >= scrollY.current && top + layout.rowH <= scrollY.current + viewH.current) return;
    // Jump on opening; follow smoothly afterwards.
    const first = scrollY.current === 0 && top > viewH.current;
    list.current?.scrollToOffset({ offset: Math.max(0, top - viewH.current / 3), animated: !first });
  }, [currentRow, layout.rowH, measuredH]);

  // ---- drag to reorder (All only) ----
  const [drag, setDrag] = React.useState<{ from: number; gap: number } | null>(null);
  const dragRef = React.useRef(drag);
  dragRef.current = drag;
  const listBox = React.useRef<React.ComponentRef<typeof View>>(null);
  const origin = React.useRef({ x: 0, y: 0 });
  const measure = () => listBox.current?.measureInWindow((x, y) => (origin.current = { x, y }));
  const gapAt = (pageX: number, pageY: number) => dropGap(pageX - origin.current.x, pageY - origin.current.y + scrollY.current, layout, entries.length);
  const pan = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponderCapture: () => !!dragRef.current,
        onMoveShouldSetPanResponderCapture: () => !!dragRef.current,
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (e) => {
          const d = dragRef.current;
          if (!d) return;
          const { pageX, pageY } = e.nativeEvent;
          const gap = gapAt(pageX, pageY);
          if (gap !== d.gap) setDrag({ ...d, gap });
          // Near the top or bottom edge: scroll the list along.
          const rel = pageY - origin.current.y;
          if (rel < 48) list.current?.scrollToOffset({ offset: Math.max(0, scrollY.current - 24), animated: false });
          else if (rel > viewH.current - 48) list.current?.scrollToOffset({ offset: scrollY.current + 24, animated: false });
        },
        onPanResponderRelease: () => {
          const d = dragRef.current;
          setDrag(null);
          if (d && d.gap !== d.from && d.gap !== d.from + 1) onMove(d.from, moveIndex(d.from, d.gap));
        },
        onPanResponderTerminate: () => setDrag(null),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, entries.length, onMove],
  );

  const pageMenu = (index: number, anchor: { x: number; y: number }) => {
    const p = pages[index];
    if (!p) return;
    setMenu({
      anchor,
      items: [
        { label: p.bookmarked ? 'Remove bookmark' : 'Bookmark', icon: 'bookmark', onPress: () => onBookmark(index) },
        { label: 'Duplicate', icon: 'copy', onPress: () => onDuplicate(index) },
        ...(onPaper && p.background.kind === 'paper' ? [{ label: 'Paper…', icon: 'file' as const, onPress: () => onPaper(index) }] : []),
        ...(index > 0 ? [{ label: 'Move up', icon: 'arrow-up' as const, onPress: () => onMove(index, index - 1) }] : []),
        ...(index < pages.length - 1 ? [{ label: 'Move down', icon: 'arrow-down' as const, onPress: () => onMove(index, index + 1) }] : []),
        { label: 'Delete page', icon: 'trash-2', tone: 'bad', onPress: () => onDelete(index) },
      ],
    });
  };

  const indicator = (() => {
    if (!drag) return null;
    const row = Math.floor(drag.gap / layout.columns);
    const col = drag.gap % layout.columns;
    if (layout.columns === 1) return { left: NAV_PAD, top: NAV_PAD + row * layout.rowH - NAV_GAP / 2 - 1, width: layout.cellW, height: 3 };
    // In a grid, a bar before the cell (or after the last cell of the previous row).
    const r = col === 0 && drag.gap > 0 ? row - 1 : row;
    const cc = col === 0 && drag.gap > 0 ? layout.columns : col;
    return { left: NAV_PAD + cc * (layout.cellW + NAV_GAP) - NAV_GAP / 2 - 1, top: NAV_PAD + r * layout.rowH, width: 3, height: layout.thumbH };
  })();

  const grid = mode === 'grid';
  return (
    <View style={[styles.panel, grid ? { flex: 1, width: '100%' } : { width, flexGrow: 0, flexShrink: 0 }, { backgroundColor: grid ? c.bg : c.surface, borderRightColor: c.line }]}>
      <View style={[styles.top, { backgroundColor: c.surface }]}>
        <View style={{ flex: 1 }}>
          <Text variant="section">Pages</Text>
          <Text variant="meta" tone="faint">
            {pages.length} {pages.length === 1 ? 'page' : 'pages'}
          </Text>
        </View>
        <IconButton icon="hash" label="Go to page" size={36} onPress={onGoTo} />
        <IconButton icon="x" label="Close pages" size={36} onPress={onClose} />
      </View>
      <View style={[styles.filter, { backgroundColor: c.surface, borderBottomColor: c.line2 }]}>
        <Segmented<NavFilter>
          value={filter}
          onChange={setFilter}
          accessibilityLabel="Show pages"
          options={[
            { value: 'all', label: 'All' },
            { value: 'bookmarks', label: bookmarks ? `Bookmarks (${bookmarks})` : 'Bookmarks' },
          ]}
        />
      </View>
      <View
        ref={listBox}
        style={{ flex: 1 }}
        onLayout={(e) => {
          viewH.current = e.nativeEvent.layout.height;
          setMeasuredH(e.nativeEvent.layout.height);
          measure();
        }}
        {...pan.panHandlers}
      >
        {rows.length ? (
          <FlatList
            ref={list}
            indicatorStyle={indicatorStyleFor(scheme)}
            data={rows}
            key={layout.columns}
            keyExtractor={(row) => row[0]!.info.id}
            getItemLayout={(_d, i) => ({ length: layout.rowH, offset: NAV_PAD + layout.rowH * i, index: i })}
            initialNumToRender={Math.max(4, Math.ceil(900 / layout.rowH)) * 1}
            windowSize={5}
            maxToRenderPerBatch={4}
            removeClippedSubviews={Platform.OS !== 'web'}
            scrollEnabled={!drag}
            contentContainerStyle={{ paddingVertical: NAV_PAD }}
            onScroll={(e) => {
              scrollY.current = e.nativeEvent.contentOffset.y;
            }}
            onScrollBeginDrag={() => (touchedAt.current = Date.now())}
            onMomentumScrollEnd={() => (touchedAt.current = Date.now())}
            scrollEventThrottle={32}
            renderItem={({ item: row }) => (
              <View style={{ height: layout.rowH, flexDirection: 'row', gap: NAV_GAP, paddingHorizontal: NAV_PAD }}>
                {row.map((entry) => (
                  <Cell
                    key={entry.info.id}
                    entry={entry}
                    layout={layout}
                    current={entry.index === current}
                    priority={Math.abs(entry.index - current)}
                    thumbs={thumbs}
                    dragging={drag?.from === entry.index}
                    onPress={() => onJump(entry.index)}
                    onLongPress={() => {
                      if (filter !== 'all') return;
                      measure();
                      setDrag({ from: entry.index, gap: entry.index });
                    }}
                    onBookmark={() => onBookmark(entry.index)}
                    onMore={(a) => pageMenu(entry.index, a)}
                  />
                ))}
              </View>
            )}
          />
        ) : (
          <EmptyState icon="bookmark" title="No bookmarks yet" body="Bookmark a page from its thumbnail to find it here quickly." />
        )}
        {indicator ? (
          <View
            pointerEvents="none"
            style={{ position: 'absolute', ...indicator, top: indicator.top - scrollY.current, backgroundColor: c.accent, borderRadius: 2 }}
          />
        ) : null}
      </View>
      <Menu visible={!!menu} onClose={() => setMenu(null)} items={menu?.items ?? []} anchor={menu ? { ...menu.anchor, align: 'right' } : undefined} />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderRightWidth: StyleSheet.hairlineWidth },
  // The same header and filter row as the comments panel, so the two sides line up.
  top: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingLeft: 16, paddingRight: 8, ...PANEL_HEADER },
  filter: { paddingHorizontal: 12, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  ring: { padding: 2, borderWidth: 2, borderRadius: 7 },
  thumb: { borderRadius: 3, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  label: { height: NAV_LABEL_H, flexDirection: 'row', alignItems: 'center' },
  side: { width: 28, alignItems: 'center' },
});
