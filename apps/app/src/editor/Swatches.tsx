import { DEFAULT_SWATCHES, HIGHLIGHTER_ALPHA, splitAlpha, type PaperColor, type SwatchTool } from '@qalm/core';
import * as React from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { GestureDetector, useExclusiveGestures, usePanGesture, useTapGesture } from 'react-native-gesture-handler';

import { useLibraryData } from '../state/session';
import { useTheme } from '../theme/ThemeProvider';
import { coverInk } from '../theme/tokens';
import { Icon } from '../ui/Icon';
import { Menu, type MenuItem } from '../ui/layout';
import { ColorPicker } from './ColorPicker';
import { contrastRatio, dropIndex, sameColor, swatchLabel } from './colors.logic';

/** One swatch slot: a 40 px target plus the row's 2 px gap. */
const SLOT = 42;
/** Hold this long before a swatch lifts to be dragged (touch and stylus scroll the toolbar before that). */
const HOLD_MS = 280;

/** The user's saved colours for a tool (tech-spec §2: the library doc), and edits to them. */
export function useSwatches(tool: SwatchTool) {
  const { library } = useLibraryData();
  const list = library ? library.swatches(tool) : [...DEFAULT_SWATCHES[tool]];
  return {
    list,
    add: (c: string) => library?.addSwatch(tool, c) ?? false,
    move: (c: string, to: number) => library?.moveSwatch(tool, c, to),
    remove: (c: string) => library?.removeSwatch(tool, c),
  };
}

/** The colour as it shows on paper: highlighters lighten with their opacity, relative to the default. */
function SwatchDot({ tool, color, selected }: { tool: SwatchTool; color: string; selected: boolean }) {
  const { c } = useTheme();
  const { rgb, alpha } = splitAlpha(color, tool === 'highlighter' ? HIGHLIGHTER_ALPHA : 1);
  const shown = tool === 'highlighter' ? Math.min(1, alpha / HIGHLIGHTER_ALPHA) : 1;
  return (
    // A swatch close to the toolbar's own colour (graphite in dark mode, white in light) gets a visible outline.
    <View style={[styles.dot, { backgroundColor: '#ffffff' }, contrastRatio(rgb, c.surface) < 1.6 ? { borderWidth: 1, borderColor: c.faint } : { borderColor: c.line }]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: rgb, opacity: shown }]} />
      {selected ? <Icon name="check" size={13} color={coverInk(rgb)} /> : null}
    </View>
  );
}

function SwatchButton({
  tool,
  color,
  index,
  count,
  selected,
  onSelect,
  onMenu,
  onDrag,
}: {
  tool: SwatchTool;
  color: string;
  index: number;
  count: number;
  selected: boolean;
  onSelect(): void;
  onMenu(at: { x: number; y: number }): void;
  /** dx while dragging; `done` on release (null: cancelled / never moved) */
  onDrag(dx: number | null, done: boolean): void;
}) {
  const { c } = useTheme();
  const ref = React.useRef<React.ComponentRef<typeof View>>(null);
  const moved = React.useRef(false);
  const menuAt = React.useCallback(() => {
    ref.current?.measureInWindow((x, y, w, h) => onMenu({ x: x + w / 2 - 20, y: y + h + 6 }));
  }, [onMenu]);
  const tap = useTapGesture({ runOnJS: true, disableReanimated: true, onActivate: onSelect });
  const pan = usePanGesture({
    runOnJS: true,
    disableReanimated: true,
    activateAfterLongPress: HOLD_MS,
    onActivate: () => {
      moved.current = false;
      onDrag(0, false);
    },
    onUpdate: (e) => {
      if (Math.abs(e.translationX) > 6) moved.current = true;
      onDrag(e.translationX, false);
    },
    onDeactivate: (e) => {
      // Held without moving: that's a long press → the swatch's menu.
      if (!moved.current) {
        onDrag(null, true);
        menuAt();
      } else onDrag(e.translationX, true);
    },
  });
  const gesture = useExclusiveGestures(pan, tap);

  // Right-click on web and desktop.
  React.useEffect(() => {
    if (Platform.OS !== 'web') return;
    const el = ref.current as unknown as HTMLElement | null;
    if (!el?.addEventListener) return;
    const h = (e: MouseEvent) => {
      e.preventDefault();
      onMenu({ x: e.clientX, y: e.clientY });
    };
    el.addEventListener('contextmenu', h);
    return () => el.removeEventListener('contextmenu', h);
  }, [onMenu]);

  const label = swatchLabel(tool, color);
  return (
    <GestureDetector gesture={gesture}>
      <View
        ref={ref}
        accessible
        accessibilityRole="radio"
        accessibilityLabel={label}
        accessibilityHint="Hold to move or remove"
        accessibilityState={{ checked: selected }}
        aria-checked={selected}
        accessibilityActions={[{ name: 'activate' }, { name: 'longpress' }]}
        onAccessibilityAction={(e) => (e.nativeEvent.actionName === 'longpress' ? menuAt() : onSelect())}
        // Keyboard on web: Enter/Space selects, the context-menu key opens the menu.
        {...((Platform.OS === 'web'
          ? {
              tabIndex: 0,
              onKeyDown: (e: { key: string; preventDefault(): void }) => {
                if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), onSelect());
                else if (e.key === 'ContextMenu' || e.key === 'Delete' || e.key === 'Backspace') (e.preventDefault(), menuAt());
              },
            }
          : {}) as object)}
        // `title` on web is the hover tooltip: the colour's name or hex.
        {...((Platform.OS === 'web' ? { title: `${label}${count > 1 ? ` (${index + 1} of ${count})` : ''}` } : {}) as object)}
        style={[styles.hit, { borderColor: selected ? c.ink : 'transparent' }]}
      >
        <SwatchDot tool={tool} color={color} selected={selected} />
      </View>
    </GestureDetector>
  );
}

export interface SwatchStripProps {
  tool: SwatchTool;
  current: string;
  onSelect(color: string): void;
  /** While a swatch is being dragged, the host should stop its own scrolling. */
  onDragging?(on: boolean): void;
  /** Label prefix for the selection bar ("Recolour"). */
  verb?: string;
  /** The page's paper: the picker previews the ink as it will look there (graphite is light on night paper). */
  paper?: PaperColor;
}

/**
 * The tool's saved colours, then "+" (the picker). Tap to use; hold and drag to reorder; hold (or right-click) for
 * Remove / Move. The current colour has an ink ring and a check (tech-spec §5).
 */
export function SwatchStrip({ tool, current, onSelect, onDragging, verb, paper }: SwatchStripProps) {
  const { c } = useTheme();
  const sw = useSwatches(tool);
  const [drag, setDrag] = React.useState<{ color: string; from: number; dx: number } | null>(null);
  const [menu, setMenu] = React.useState<{ color: string; at: { x: number; y: number } } | null>(null);
  const [picker, setPicker] = React.useState<{ x: number; y: number } | null>(null);
  const plusRef = React.useRef<React.ComponentRef<typeof View>>(null);
  const dragging = React.useRef(false);

  const list = sw.list;
  const to = drag ? dropIndex(drag.from, drag.dx, SLOT, list.length) : -1;
  // While dragging, lay the others out as if the dragged one were already at `to`.
  const offsetFor = (i: number): number => {
    if (!drag) return 0;
    if (i === drag.from) return drag.dx;
    if (drag.from < to && i > drag.from && i <= to) return -SLOT;
    if (drag.from > to && i >= to && i < drag.from) return SLOT;
    return 0;
  };

  const menuItems = (color: string): MenuItem[] => {
    const i = list.indexOf(color);
    const items: MenuItem[] = [];
    if (i > 0) items.push({ label: 'Move left', icon: 'chevron-left', onPress: () => sw.move(color, i - 1) });
    if (i >= 0 && i < list.length - 1) items.push({ label: 'Move right', icon: 'chevron-right', onPress: () => sw.move(color, i + 1) });
    items.push({ label: 'Remove colour', description: swatchLabel(tool, color), icon: 'trash-2', tone: 'bad', onPress: () => sw.remove(color) });
    return items;
  };

  return (
    <>
      <View accessibilityRole="radiogroup" accessibilityLabel={tool === 'highlighter' ? 'Highlighter colours' : 'Colours'} style={styles.row}>
        {list.map((col, i) => (
          <View key={col} style={drag ? { transform: [{ translateX: offsetFor(i) }, { scale: drag.from === i ? 1.12 : 1 }], zIndex: drag.from === i ? 2 : 0 } : null}>
            <SwatchButton
              tool={tool}
              color={col}
              index={i}
              count={list.length}
              selected={sameColor(col, current)}
              onSelect={() => onSelect(col)}
              onMenu={(at) => setMenu({ color: col, at })}
              onDrag={(dx, done) => {
                if (!done) {
                  if (!dragging.current) onDragging?.(true);
                  dragging.current = true;
                  setDrag({ color: col, from: i, dx: dx ?? 0 });
                  return;
                }
                if (dx !== null) sw.move(col, dropIndex(i, dx, SLOT, list.length));
                setDrag(null);
                if (dragging.current) onDragging?.(false);
                dragging.current = false;
              }}
            />
          </View>
        ))}
        <Pressable
          ref={plusRef}
          accessibilityRole="button"
          accessibilityLabel={verb ? `${verb}: more colours` : 'Add a colour'}
          onPress={() => plusRef.current?.measureInWindow((x, y, w, h) => setPicker({ x: x + w / 2, y: y + h + 8 }))}
          style={(s) => [styles.hit, { borderColor: 'transparent' }, ((s as { hovered?: boolean }).hovered || s.pressed) && { backgroundColor: c.soft }]}
        >
          <View style={[styles.dot, styles.plus, { borderColor: c.faint }]}>
            <Icon name="plus" size={14} color={c.ink2} />
          </View>
        </Pressable>
      </View>
      <Menu visible={!!menu} onClose={() => setMenu(null)} items={menu ? menuItems(menu.color) : []} anchor={menu?.at} width={220} />
      <ColorPicker
        visible={!!picker}
        tool={tool}
        paper={paper}
        initial={current}
        saved={list}
        anchor={picker ?? undefined}
        onClose={() => setPicker(null)}
        onPick={(col, save) => {
          if (save) sw.add(col);
          onSelect(col);
          setPicker(null);
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  hit: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20, borderWidth: 2 },
  dot: { width: 24, height: 24, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  plus: { borderStyle: 'dashed', borderWidth: 1.5, backgroundColor: 'transparent' },
});
