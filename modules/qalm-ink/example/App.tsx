import { StatusBar } from 'expo-status-bar';
import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { hitTestErase, type Item, type PageInfo, type StrokeItem } from '@qalm/core';

import { InkOverlay, PageCanvas } from '../src';
import type { InkInputSettings, InkTool } from '../src/InkOverlay.types';

const A4 = { w: 595, h: 842 };
const PAGE: PageInfo = { id: 'p1', size: A4, paper: 'ruled', paperColor: 'white', background: { kind: 'paper' } };
const INPUT: InkInputSettings = { drawWith: 'any', hand: 'right', palm: 'standard' };
const TOOLS: InkTool[] = ['pen', 'highlighter', 'eraser', 'lasso', 'none'];
const BRUSH: Record<InkTool, { color: string; width: number }> = {
  pen: { color: '#27272a', width: 1.8 },
  highlighter: { color: '#fde68a', width: 12 },
  eraser: { color: '#27272a', width: 8 },
  lasso: { color: '#4338ca', width: 1 },
  none: { color: '#27272a', width: 1 },
};

export default function App() {
  const { width: winW } = useWindowDimensions();
  const pageW = Math.min(winW - 32, 820);
  const pageH = (pageW * A4.h) / A4.w;
  const [tool, setTool] = React.useState<InkTool>('pen');
  const [items, setItems] = React.useState<Item[]>([]);
  const [committedIds, setCommittedIds] = React.useState<string[]>([]);
  // Hand-off: once PageCanvas has rendered the new items, tell the overlay it may stop drawing them.
  React.useEffect(() => setCommittedIds(items.map((it) => it.id)), [items]);
  const [log, setLog] = React.useState<string[]>([]);
  const add = (line: string) => {
    console.log(line);
    setLog((l) => [line, ...l].slice(0, 8));
  };

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <View style={styles.toolbar}>
        {TOOLS.map((t) => (
          <Pressable key={t} onPress={() => setTool(t)} style={[styles.tool, t === tool && styles.toolOn]}>
            <Text style={[styles.toolText, t === tool && styles.toolTextOn]}>{t}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.page, { width: pageW, height: pageH }]}>
          <PageCanvas info={PAGE} items={items} width={pageW} />
          <InkOverlay
            pageSize={A4}
            tool={tool}
            color={BRUSH[tool].color}
            width={BRUSH[tool].width}
            input={INPUT}
            committedIds={committedIds}
            onStrokeEnd={({ nativeEvent: e }) => {
              add(`stroke ${e.tool} ${e.id.slice(0, 8)} pts=${e.points.length} held=${e.heldMs}ms`);
              const xs = e.points.map((p) => p.x);
              const ys = e.points.map((p) => p.y);
              const r = e.width / 2;
              const stroke: StrokeItem = {
                id: e.id, type: 'stroke', tool: e.tool, color: e.color, width: e.width, points: e.points, createdAt: Date.now(),
                bbox: [Math.min(...xs) - r, Math.min(...ys) - r, Math.max(...xs) + r, Math.max(...ys) + r],
              };
              setItems((its) => [...its, stroke]);
            }}
            onErase={({ nativeEvent: e }) => {
              add(`erase ${e.path.length} pts`);
              setItems((its) => {
                const hit = new Set(hitTestErase(its, e.path, BRUSH.eraser.width / 2));
                return hit.size ? its.filter((it) => !hit.has(it.id)) : its;
              });
            }}
            onLasso={({ nativeEvent: e }) => add(`lasso ${e.polygon.length} pts`)}
            onPenButton={({ nativeEvent: e }) => {
              add(`pen button ${e.kind}`);
              setTool('eraser');
            }}
            onRejectedTouch={({ nativeEvent: e }) => add(`rejected ${e.reason}`)}
          />
        </View>
        <Pressable onPress={() => setItems([])} style={styles.tool}>
          <Text style={styles.toolText}>clear page</Text>
        </Pressable>
      </ScrollView>
      <View style={styles.log} pointerEvents="none">
        {log.map((l, i) => (
          <Text key={i} style={styles.logText}>
            {l}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f3f3f5', paddingTop: 40 },
  toolbar: { flexDirection: 'row', gap: 8, padding: 12, justifyContent: 'center' },
  tool: { height: 44, paddingHorizontal: 14, borderRadius: 8, justifyContent: 'center', backgroundColor: '#ffffff', borderWidth: 1, borderColor: '#d3d3d9' },
  toolOn: { backgroundColor: '#4338ca', borderColor: '#4338ca' },
  toolText: { color: '#27272a', fontSize: 14 },
  toolTextOn: { color: '#ffffff' },
  scroll: { alignItems: 'center', padding: 16, gap: 16 },
  page: { backgroundColor: '#ffffff', overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: '#d3d3d9' },
  log: { position: 'absolute', left: 12, bottom: 12, padding: 8, borderRadius: 8, backgroundColor: '#ffffff', borderWidth: 1, borderColor: '#d3d3d9' },
  logText: { fontSize: 12, color: '#5c5c65', fontFamily: 'monospace' },
});
