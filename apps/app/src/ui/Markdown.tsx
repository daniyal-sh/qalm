import { allowedMath, mathDeferredEpoch, onMathDeferred, parseMarkdown, texToPath, type MathBox, type MdBlock, type MdInline } from '@qalm/core';
import * as React from 'react';
import { Linking, Platform, StyleSheet, View, type TextStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useTheme } from '../theme/ThemeProvider';
import { font, typeRamp } from '../theme/tokens';
import { Text } from './Text';

/** Maths is drawn this much larger than the text (as in text boxes: Computer Modern runs small next to Figtree). */
const MATH_SCALE = 1.15;
const HEADING = [1.3, 1.15, 1.05, 1, 1, 1];

/** The comment's formulas that may render (`allowedMath`: a cap per comment); the rest show their source. */
const MathAllowed = React.createContext<ReadonlySet<object>>(new Set());

/** TeX as an inline SVG of its outlines (the same paths text boxes draw), sitting on the text's baseline. */
function MathSvg({ box, size, color }: { box: MathBox; size: number; color: string }) {
  const z = size * MATH_SCALE;
  const w = Math.max(1, box.w * z);
  const h = Math.max(1, (box.a + box.d) * z);
  const drop = box.d * z;
  // An inline view sits on the baseline: move it down by its depth (web: vertical-align does the same).
  const style = Platform.OS === 'web' ? ({ verticalAlign: -drop } as object) : { transform: [{ translateY: drop }] };
  return (
    <Svg width={w} height={h} viewBox={`0 ${-box.a * 1000} ${box.w * 1000} ${(box.a + box.d) * 1000}`} style={style}>
      <Path d={box.path} fill={color} />
    </Svg>
  );
}

/** Opacity of maths' raw TeX while MathJax loads (core loads it on demand; text boxes show the same placeholder). */
const PENDING_OPACITY = 0.55;

function inlineStyle(m: MdInline & { t: 'text' | 'math' }, colors: { link: string; code: string }): TextStyle {
  const s: { -readonly [K in keyof TextStyle]: TextStyle[K] } = {};
  const { b, i, s: strike, code, href } = m.m;
  if (code) {
    s.fontFamily = font.mono;
    s.backgroundColor = colors.code;
    s.fontSize = 14;
  } else if (b && i) s.fontFamily = 'Figtree_700Bold_Italic';
  else if (b) s.fontFamily = font.bold;
  else if (i) s.fontFamily = 'Figtree_400Regular_Italic';
  const lines = [href ? 'underline' : '', strike ? 'line-through' : ''].filter(Boolean).join(' ');
  if (lines) s.textDecorationLine = lines as TextStyle['textDecorationLine'];
  if (href) s.color = colors.link;
  return s;
}

function Inlines({ c: items, size, color }: { c: readonly MdInline[]; size: number; color: string }) {
  const { c } = useTheme();
  const allowed = React.useContext(MathAllowed);
  const colors = { link: c.accent, code: c.soft };
  return (
    <>
      {items.map((x, k) => {
        if (x.t === 'br') return '\n';
        if (x.t === 'math') {
          const box = allowed.has(x) ? texToPath(x.tex, false) : null;
          if (box) return <MathSvg key={k} box={box} size={size} color={color} />;
          // MathJax not loaded yet: the raw TeX, muted. A TeX error, past the limits or deferred: the source as code.
          return (
            <Text key={k} style={box === undefined ? [inlineStyle(x, colors), styles.pending] : inlineStyle({ ...x, m: { ...x.m, code: true } }, colors)}>
              {`$${x.tex}$`}
            </Text>
          );
        }
        const href = x.m.href;
        return (
          <Text
            key={k}
            style={inlineStyle(x, colors)}
            {...(href ? { accessibilityRole: 'link' as const, onPress: () => void Linking.openURL(href) } : null)}
          >
            {x.text}
          </Text>
        );
      })}
    </>
  );
}

function Blocks({ blocks, size, color, depth = 0 }: { blocks: readonly MdBlock[]; size: number; color: string; depth?: number }) {
  const { c } = useTheme();
  const allowed = React.useContext(MathAllowed);
  return (
    <View style={styles.blocks}>
      {blocks.map((b, k) => {
        switch (b.t) {
          case 'p':
            return (
              <Text key={k} variant="body" style={{ color }}>
                <Inlines c={b.c} size={size} color={color} />
              </Text>
            );
          case 'h': {
            const z = Math.round(size * (HEADING[b.level - 1] ?? 1));
            return (
              <Text key={k} accessibilityRole="header" style={{ color, fontFamily: font.bold, fontSize: z, lineHeight: Math.round(z * 1.35) }}>
                <Inlines c={b.c} size={z} color={color} />
              </Text>
            );
          }
          case 'quote':
            return (
              <View key={k} style={[styles.quote, { borderLeftColor: c.line }]}>
                <Blocks blocks={b.c} size={size} color={color} depth={depth} />
              </View>
            );
          case 'list':
            return (
              <View key={k} style={styles.list}>
                {b.items.map((item, i) => (
                  <View key={i} style={styles.item}>
                    <Text variant="body" style={[styles.marker, { color }]}>
                      {b.ordered ? `${b.start + i}.` : depth % 2 ? '–' : '•'}
                    </Text>
                    <View style={{ flex: 1 }}>
                      <Blocks blocks={item} size={size} color={color} depth={depth + 1} />
                    </View>
                  </View>
                ))}
              </View>
            );
          case 'code':
            return (
              <View key={k} style={[styles.code, { backgroundColor: c.soft }]}>
                <Text style={{ fontFamily: font.mono, fontSize: 13, lineHeight: 19, color }}>{b.text}</Text>
              </View>
            );
          case 'math': {
            const box = allowed.has(b) ? texToPath(b.tex, true) : null;
            if (box === undefined)
              return (
                <View key={k} style={styles.mathBlock}>
                  <Text style={[styles.pending, { fontFamily: font.mono, fontSize: 13, lineHeight: 19, color }]}>{`$$${b.tex}$$`}</Text>
                </View>
              );
            return box ? (
              <View key={k} style={styles.mathBlock} accessibilityLabel={b.tex}>
                <MathSvg box={box} size={size} color={color} />
              </View>
            ) : (
              <View key={k} style={[styles.code, { backgroundColor: c.soft }]}>
                <Text style={{ fontFamily: font.mono, fontSize: 13, lineHeight: 19, color }}>{`$$${b.tex}$$`}</Text>
              </View>
            );
          }
          case 'hr':
            return <View key={k} style={[styles.hr, { backgroundColor: c.line }]} />;
        }
      })}
    </View>
  );
}

/**
 * A comment's text as Markdown (the same parser as text boxes): bold, italic, strikethrough, headings, lists, quotes,
 * code, links (http, https and mailto only) and TeX maths (capped per comment). Raw HTML shows as text, never rendered.
 */
export function Markdown({ text, color }: { text: string; color?: string }) {
  const { c } = useTheme();
  const blocks = React.useMemo(() => parseMarkdown(text), [text]);
  // Maths the time slice deferred (a long thread renders in one task), or waiting on MathJax (loaded on demand), fills
  // in on later renders.
  const [fill, setFill] = React.useState(mathDeferredEpoch);
  React.useEffect(() => onMathDeferred(() => setFill(mathDeferredEpoch())), []);
  const allowed = React.useMemo(() => allowedMath(blocks), [blocks, fill]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <MathAllowed.Provider value={allowed}>
      <Blocks blocks={blocks} size={typeRamp.body.fontSize} color={color ?? c.ink} />
    </MathAllowed.Provider>
  );
}

const styles = StyleSheet.create({
  blocks: { gap: 6 },
  quote: { borderLeftWidth: 3, paddingLeft: 10 },
  list: { gap: 2 },
  item: { flexDirection: 'row', gap: 6 },
  marker: { minWidth: 16, textAlign: 'right' },
  code: { borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8 },
  mathBlock: { alignItems: 'center', paddingVertical: 4 },
  pending: { fontFamily: font.mono, opacity: PENDING_OPACITY },
  hr: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
});
