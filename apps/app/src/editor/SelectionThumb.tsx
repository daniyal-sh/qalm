import type { BBox, Item, PageInfo } from '@qalm/core';
import { PageCanvas } from 'qalm-ink';
import * as React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { radius } from '../theme/tokens';

const PAD = 8; // page units around the selection
const MAX_CANVAS_W = 1600; // px; caps the zoom for tiny selections

/** A crop of the page around `bbox`, drawn by the same renderer as the page (only `items` are drawn). */
export function SelectionThumb({ info, items, bbox, maxW = 420, maxH = 140 }: { info: PageInfo; items: Item[]; bbox: BBox; maxW?: number; maxH?: number }) {
  const { c } = useTheme();
  const x0 = Math.max(0, bbox[0] - PAD);
  const y0 = Math.max(0, bbox[1] - PAD);
  const w = Math.max(1, Math.min(info.size.w, bbox[2] + PAD) - x0);
  const h = Math.max(1, Math.min(info.size.h, bbox[3] + PAD) - y0);
  const s = Math.min(maxW / w, maxH / h, 3, MAX_CANVAS_W / info.size.w);
  return (
    <View
      accessibilityLabel="The selection"
      style={[styles.box, { width: Math.ceil(w * s), height: Math.ceil(h * s), borderColor: c.line }]}
    >
      <View style={{ position: 'absolute', left: -x0 * s, top: -y0 * s }} pointerEvents="none">
        <PageCanvas info={info} items={items} width={info.size.w * s} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { overflow: 'hidden', borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, alignSelf: 'center' },
});
