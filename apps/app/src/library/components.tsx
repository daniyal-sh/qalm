import type { Folder, LibraryEntry, Paper, PaperColor } from '@qalm/core';
import * as React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { COVERS, coverInk, font, PAPER_SWATCH, radius, shadow1 } from '../theme/tokens';
import { Button, IconButton, Pill, Segmented, TextField, Toggle } from '../ui/controls';
import { Icon } from '../ui/Icon';
import { Row, Sheet } from '../ui/layout';
import { Text } from '../ui/Text';
import { DEFAULT_TITLE, relativeTime, type NewNotebookForm, type PageSizeName } from './actions';

/** Solid cover: 4 px spine side, 10 px open side, with a surface label sticker. */
export function Cover({ color, title, width, pdf }: { color: string; title: string; width: number; pdf?: boolean }) {
  const { c } = useTheme();
  const h = Math.round(width * 1.3);
  return (
    <View
      style={[
        styles.cover,
        shadow1,
        { width, height: h, backgroundColor: color, borderColor: c.line },
      ]}
    >
      <View style={[styles.sticker, { backgroundColor: c.surface, borderColor: c.line, maxWidth: width - 28 }]}>
        <Text variant="meta" numberOfLines={2} style={{ color: c.ink, fontFamily: font.semibold, fontSize: Math.max(10, Math.min(13, width / 13)) }}>
          {title || DEFAULT_TITLE}
        </Text>
      </View>
      {pdf ? (
        <View style={{ position: 'absolute', right: 8, bottom: 8 }}>
          <Pill label="PDF" tone="context" />
        </View>
      ) : null}
    </View>
  );
}

export function NotebookCard({
  entry,
  width,
  pdf,
  onOpen,
  onMenu,
}: {
  entry: LibraryEntry;
  width: number;
  pdf?: boolean;
  onOpen(): void;
  onMenu(anchor: { x: number; y: number }): void;
}) {
  const { c } = useTheme();
  return (
    <View style={{ width, gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${entry.title || DEFAULT_TITLE}`}
        onPress={onOpen}
        onLongPress={(e) => onMenu({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY })}
        style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
      >
        <Cover color={entry.cover} title={entry.title} width={width} pdf={pdf} />
      </Pressable>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 4 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label" numberOfLines={1}>
            {entry.title || DEFAULT_TITLE}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Text variant="meta" tone="faint">
              {entry.deletedAt ? `Deleted ${relativeTime(entry.deletedAt).toLowerCase()}` : relativeTime(entry.updatedAt)}
            </Text>
            {entry.favorite ? <Icon name="star" size={12} color={c.warn} /> : null}
            {entry.aiAccess ? <Pill label="AI" tone="assistant" /> : null}
          </View>
        </View>
        <IconButton
          icon="more-horizontal"
          label={`More for ${entry.title || DEFAULT_TITLE}`}
          size={32}
          onPress={(e) => onMenu({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY })}
        />
      </View>
    </View>
  );
}

export function FolderTile({ folder, count, width, onOpen, onMenu }: { folder: Folder; count: number; width: number; onOpen(): void; onMenu(a: { x: number; y: number }): void }) {
  const { c } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open folder ${folder.name}`}
      onPress={onOpen}
      onLongPress={(e) => onMenu({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY })}
      style={(s) => [
        styles.folder,
        { width, backgroundColor: (s as { hovered?: boolean }).hovered || s.pressed ? c.surface2 : c.surface, borderColor: c.line },
        shadow1,
      ]}
    >
      <Icon name="folder" size={20} color={c.accentInk} />
      <View style={{ flex: 1 }}>
        <Text variant="label" numberOfLines={1}>
          {folder.name}
        </Text>
        <Text variant="meta" tone="faint">
          {count === 1 ? '1 notebook' : `${count} notebooks`}
        </Text>
      </View>
      <IconButton icon="more-horizontal" label={`More for ${folder.name}`} size={32} onPress={(e) => onMenu({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY })} />
    </Pressable>
  );
}

const PAPERS: { value: Paper; label: string }[] = [
  { value: 'blank', label: 'Blank' },
  { value: 'ruled', label: 'Ruled' },
  { value: 'dotted', label: 'Dotted' },
  { value: 'grid', label: 'Grid' },
  { value: 'cornell', label: 'Cornell' },
  { value: 'weekly', label: 'Weekly' },
];

export const DEFAULT_FORM: NewNotebookForm = {
  title: '',
  cover: COVERS[1].hex,
  paper: 'ruled',
  paperColor: 'white',
  size: 'A4',
  orientation: 'portrait',
  aiAccess: false,
};

function Swatches({ value, onChange }: { value: string; onChange(hex: string): void }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityRole="radiogroup" accessibilityLabel="Cover colour">
      {COVERS.map((cv) => {
        const on = cv.hex === value;
        return (
          <Pressable
            key={cv.hex}
            accessibilityRole="radio"
            accessibilityLabel={cv.name}
            accessibilityState={{ checked: on }}
            onPress={() => onChange(cv.hex)}
            style={[styles.swatchHit, on && { borderColor: c.accent }]}
          >
            <View style={[styles.swatch, { backgroundColor: cv.hex, borderColor: c.line }]}>
              {on ? <Icon name="check" size={16} color={coverInk(cv.hex)} /> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

export function NewNotebookSheet({ visible, onClose, onCreate }: { visible: boolean; onClose(): void; onCreate(f: NewNotebookForm): Promise<void> }) {
  const { c } = useTheme();
  const [f, setF] = React.useState<NewNotebookForm>(DEFAULT_FORM);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (visible) setF(DEFAULT_FORM);
  }, [visible]);
  const set = (p: Partial<NewNotebookForm>) => setF((x) => ({ ...x, ...p }));
  const create = async () => {
    setBusy(true);
    try {
      await onCreate(f);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="New notebook"
      width={600}
      footer={
        <>
          <Button label="Cancel" onPress={onClose} />
          <Button label="Create" variant="primary" loading={busy} onPress={create} />
        </>
      }
    >
      <View style={{ flexDirection: 'row', gap: 20, flexWrap: 'wrap' }}>
        <Cover color={f.cover} title={f.title || DEFAULT_TITLE} width={120} />
        <View style={{ flex: 1, minWidth: 220, gap: 12 }}>
          <TextField value={f.title} onChangeText={(title) => set({ title })} placeholder={DEFAULT_TITLE} autoFocus accessibilityLabel="Title" onSubmitEditing={create} />
          <Text variant="meta">Cover</Text>
          <Swatches value={f.cover} onChange={(cover) => set({ cover })} />
        </View>
      </View>
      <View style={{ gap: 8 }}>
        <Text variant="meta">Paper</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {PAPERS.map((p) => {
            const on = p.value === f.paper;
            return (
              <Pressable
                key={p.value}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                onPress={() => set({ paper: p.value })}
                style={[styles.paperChip, { backgroundColor: on ? c.accentSoft : c.surface, borderColor: on ? c.accentLine : c.line }]}
              >
                <PaperGlyph paper={p.value} color={on ? c.accentInk : c.muted} />
                <Text variant="label" style={{ color: on ? c.accentInk : c.ink2 }}>
                  {p.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
        <View style={{ gap: 8 }}>
          <Text variant="meta">Size</Text>
          <Segmented<PageSizeName>
            value={f.size}
            onChange={(size) => set({ size })}
            options={[
              { value: 'A4', label: 'A4' },
              { value: 'Letter', label: 'Letter' },
              { value: 'A5', label: 'A5' },
            ]}
          />
        </View>
        <View style={{ gap: 8 }}>
          <Text variant="meta">Orientation</Text>
          <Segmented
            value={f.orientation}
            onChange={(orientation) => set({ orientation })}
            options={[
              { value: 'portrait', label: 'Portrait' },
              { value: 'landscape', label: 'Landscape' },
            ]}
          />
        </View>
        <View style={{ gap: 8 }}>
          <Text variant="meta">Paper colour</Text>
          <Segmented<PaperColor>
            value={f.paperColor}
            onChange={(paperColor) => set({ paperColor })}
            options={[
              { value: 'white', label: 'White', swatch: PAPER_SWATCH.white },
              { value: 'cream', label: 'Cream', swatch: PAPER_SWATCH.cream },
              { value: 'night', label: 'Night', swatch: PAPER_SWATCH.night },
            ]}
          />
        </View>
      </View>
      <View style={{ borderWidth: StyleSheet.hairlineWidth, borderColor: c.line, borderRadius: radius.control }}>
        <Row title="AI access" description="Let connected agents read and comment on this notebook" last>
          <Toggle label="AI access" value={f.aiAccess} onChange={(aiAccess) => set({ aiAccess })} />
        </Row>
      </View>
      <Text variant="meta" tone="faint">
        You can change the paper for each page later.
      </Text>
    </Sheet>
  );
}

function PaperGlyph({ paper, color }: { paper: Paper; color: string }) {
  const lines = paper === 'ruled' || paper === 'cornell' ? [5, 9, 13] : [];
  return (
    <View style={{ width: 16, height: 18, borderWidth: 1, borderColor: color, borderRadius: 2, overflow: 'hidden' }}>
      {lines.map((y) => (
        <View key={y} style={{ position: 'absolute', left: 2, right: 2, top: y, height: 1, backgroundColor: color }} />
      ))}
      {paper === 'dotted'
        ? [
            [4, 5],
            [9, 5],
            [4, 10],
            [9, 10],
          ].map(([x, y]) => <View key={`${x}-${y}`} style={{ position: 'absolute', left: x, top: y, width: 2, height: 2, borderRadius: 1, backgroundColor: color }} />)
        : null}
      {paper === 'grid' ? (
        <>
          <View style={{ position: 'absolute', left: 7, top: 0, bottom: 0, width: 1, backgroundColor: color }} />
          <View style={{ position: 'absolute', top: 8, left: 0, right: 0, height: 1, backgroundColor: color }} />
        </>
      ) : null}
      {paper === 'cornell' ? <View style={{ position: 'absolute', left: 5, top: 0, bottom: 0, width: 1, backgroundColor: color }} /> : null}
      {paper === 'weekly' ? <View style={{ position: 'absolute', left: 0, right: 0, top: 8, height: 1, backgroundColor: color }} /> : null}
    </View>
  );
}

export function NameSheet({
  visible,
  title,
  initial,
  placeholder,
  action,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  title: string;
  initial: string;
  placeholder: string;
  action: string;
  onClose(): void;
  onSubmit(v: string): void;
}) {
  const [v, setV] = React.useState(initial);
  React.useEffect(() => {
    if (visible) setV(initial);
  }, [visible, initial]);
  const submit = () => {
    if (!v.trim()) return;
    onSubmit(v.trim());
  };
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={title}
      width={440}
      footer={
        <>
          <Button label="Cancel" onPress={onClose} />
          <Button label={action} variant="primary" disabled={!v.trim()} onPress={submit} />
        </>
      }
    >
      <TextField value={v} onChangeText={setV} placeholder={placeholder} autoFocus selectTextOnFocus onSubmitEditing={submit} accessibilityLabel={title} />
    </Sheet>
  );
}

export function MoveSheet({
  visible,
  folders,
  current,
  onClose,
  onMove,
}: {
  visible: boolean;
  folders: Folder[];
  current: string | null;
  onClose(): void;
  onMove(folderId: string | null): void;
}) {
  const { c } = useTheme();
  const rows: { id: string | null; name: string }[] = [{ id: null, name: 'No folder' }, ...folders.map((f) => ({ id: f.id, name: f.name }))];
  return (
    <Sheet visible={visible} onClose={onClose} title="Move to folder" width={420}>
      <View style={{ borderWidth: StyleSheet.hairlineWidth, borderColor: c.line, borderRadius: radius.control, overflow: 'hidden' }}>
        {rows.map((r, i) => (
          <Row key={r.id ?? 'none'} title={r.name} icon={r.id ? 'folder' : 'inbox'} last={i === rows.length - 1} onPress={() => onMove(r.id)}>
            {r.id === current ? <Icon name="check" size={18} color={c.accentInk} /> : null}
          </Row>
        ))}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  cover: {
    borderTopLeftRadius: 4,
    borderBottomLeftRadius: 4,
    borderTopRightRadius: 10,
    borderBottomRightRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sticker: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 4, borderWidth: StyleSheet.hairlineWidth, marginLeft: 6 },
  folder: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 14,
    paddingRight: 6,
    height: 64,
    borderRadius: radius.panel,
    borderWidth: StyleSheet.hairlineWidth,
  },
  swatchHit: { padding: 2, borderRadius: 20, borderWidth: 2, borderColor: 'transparent' },
  swatch: { width: 32, height: 32, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  paperChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 44,
    paddingHorizontal: 12,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
