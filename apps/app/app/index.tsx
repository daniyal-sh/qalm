import type { Folder, LibraryEntry } from '@qalm/core';
import { Redirect, router } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DEFAULT_TITLE, folderCounts, visibleEntries, type LibraryFilter } from '../src/library/actions';
import { CoverSheet, DEFAULT_FORM, FolderTile, MoveSheet, NameSheet, NewNotebookSheet, NotebookCard } from '../src/library/components';
import { createNotebook, deleteForever, exportNotebook, importPdf, importQalm, updateNotebookMeta, type Ctx } from '../src/library/ops';
import { pickFile } from '../src/lib/files';
import { isPdf, isQalm } from '../src/lib/mime';
import { useLibraryData, useSession } from '../src/state/session';
import { Appear, hoverTransition } from '../src/theme/motion';
import { useTheme } from '../src/theme/ThemeProvider';
import { shadow2, space } from '../src/theme/tokens';
import { Lockup } from '../src/ui/brand';
import { confirm } from '../src/ui/confirm';
import { Avatar, Button, Chip, IconButton, TextField } from '../src/ui/controls';
import { Icon, type IconName } from '../src/ui/Icon';
import { EmptyState, Menu, SectionLabel, useToast, type MenuItem } from '../src/ui/layout';
import { ScrollRow } from '../src/ui/ScrollRow';
import { Text } from '../src/ui/Text';

type MenuState = { items: MenuItem[]; anchor: { x: number; y: number; align?: 'left' | 'right' } } | null;

function filterTitle(f: LibraryFilter, folders: Folder[]): string {
  switch (f.kind) {
    case 'all':
      return 'All notebooks';
    case 'favorites':
      return 'Favorites';
    case 'ai':
      return 'Shared with AI';
    case 'trash':
      return 'Recently deleted';
    case 'folder':
      return folders.find((x) => x.id === f.id)?.name ?? 'Folder';
  }
}

function NavItem({ icon, label, count, selected, onPress }: { icon: IconName; label: string; count?: number; selected: boolean; onPress(): void }) {
  const { c } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={(s) => [
        styles.nav,
        hoverTransition,
        { backgroundColor: selected ? c.accentSoft : s.pressed ? c.soft : (s as { hovered?: boolean }).hovered ? c.surface2 : 'transparent' },
      ]}
    >
      <Icon name={icon} size={17} color={selected ? c.accentInk : c.muted} />
      <Text variant="label" numberOfLines={1} style={{ flex: 1, color: selected ? c.accentInk : c.ink2 }}>
        {label}
      </Text>
      {count !== undefined ? (
        <Text variant="meta" style={{ color: selected ? c.accentInk : c.faint, fontVariant: ['tabular-nums'] }}>
          {count}
        </Text>
      ) : null}
    </Pressable>
  );
}

export default function LibraryScreen() {
  const { c } = useTheme();
  const s = useSession();
  const { library, entries, folders } = useLibraryData();
  const win = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wide = win.width >= 900;
  const [filter, setFilter] = React.useState<LibraryFilter>({ kind: 'all' });
  const [query, setQuery] = React.useState('');
  const [menu, setMenu] = React.useState<MenuState>(null);
  const [newOpen, setNewOpen] = React.useState(false);
  const [rename, setRename] = React.useState<LibraryEntry | null>(null);
  const [coverFor, setCoverFor] = React.useState<LibraryEntry | null>(null);
  const [renameFolder, setRenameFolder] = React.useState<Folder | null>(null);
  const [newFolder, setNewFolder] = React.useState(false);
  const [move, setMove] = React.useState<LibraryEntry | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [toast, showToast] = useToast();
  const [gridW, setGridW] = React.useState(0);

  if (s.ready && s.serverUrl && !s.user && !s.skipped) return <Redirect href="/sign-in" />;

  const ctx: Ctx | null = library ? { dm: s.dm, assets: s.assets, library, server: s.user ? s.tm : null } : null;
  const folderId = filter.kind === 'folder' ? filter.id : null;
  const shown = visibleEntries(entries, filter, query);
  const counts = folderCounts(entries);
  const live = entries.filter((e) => !e.deletedAt);
  const showFolders = filter.kind === 'all' && !query.trim() && folders.length > 0;

  // Grid: covers 150–200 px wide, filling the row.
  const cols = Math.max(2, Math.floor((gridW + 20) / (wide ? 190 : 160)));
  const cardW = gridW > 0 ? Math.floor((gridW - 20 * (cols - 1)) / cols) : 150;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const open = (id: string) => router.push({ pathname: '/notebook/[id]', params: { id } });

  const importFile = () =>
    void run('Importing…', async () => {
      if (!ctx) return;
      const f = await pickFile(['application/pdf', '.qalm', 'application/octet-stream', 'application/zip']);
      if (!f) return;
      let id: string;
      if (isQalm(f.name)) id = await importQalm(ctx, f, folderId);
      else if (isPdf(f.mime, f.name)) id = await importPdf(ctx, f, folderId, DEFAULT_FORM.cover);
      else throw new Error('Pick a PDF or a .qalm backup');
      open(id);
    });

  const newMenu = (anchor: { x: number; y: number }) =>
    setMenu({
      anchor: { ...anchor, align: 'right' },
      items: [
        { label: 'Notebook', icon: 'book', description: 'Pick a cover and a paper', onPress: () => setNewOpen(true) },
        { label: 'Folder', icon: 'folder-plus', onPress: () => setNewFolder(true) },
        { label: 'Import', icon: 'upload', tone: 'context', description: 'PDF or .qalm backup', onPress: importFile },
      ],
    });

  const entryMenu = (e: LibraryEntry, anchor: { x: number; y: number }) => {
    if (!ctx) return;
    const items: MenuItem[] = e.deletedAt
      ? [
          { label: 'Restore', icon: 'rotate-ccw', onPress: () => ctx.library.updateEntry(e.id, { deletedAt: null }) },
          {
            label: 'Delete forever',
            icon: 'trash-2',
            tone: 'bad',
            onPress: () =>
              confirm(
                'Delete forever?',
                // Signed out, a notebook only lives on this device.
                `"${e.title || DEFAULT_TITLE}" will be removed from this device${s.user ? ' and your account' : ''}. This can't be undone.`,
                'Delete',
                () => void run('Deleting…', () => deleteForever(ctx, e.id)),
              ),
          },
        ]
      : [
          { label: 'Open', icon: 'book-open', onPress: () => open(e.id) },
          { label: 'Rename', icon: 'edit-2', onPress: () => setRename(e) },
          { label: 'Cover…', icon: 'book', onPress: () => setCoverFor(e) },
          { label: e.favorite ? 'Remove from favorites' : 'Add to favorites', icon: 'star', onPress: () => ctx.library.updateEntry(e.id, { favorite: !e.favorite }) },
          { label: 'Move to folder', icon: 'folder', onPress: () => setMove(e) },
          {
            label: e.aiAccess ? 'Turn off AI access' : 'Turn on AI access',
            icon: 'cpu',
            tone: 'assistant',
            onPress: () => void run('Saving…', () => updateNotebookMeta(ctx, e.id, { aiAccess: !e.aiAccess })),
          },
          { label: 'Export PDF', icon: 'file-text', onPress: () => void run('Exporting…', () => exportNotebook(ctx, e.id, 'pdf')) },
          { label: 'Export .qalm backup', icon: 'archive', onPress: () => void run('Exporting…', () => exportNotebook(ctx, e.id, 'qalm')) },
          { label: 'Delete', icon: 'trash-2', tone: 'bad', onPress: () => ctx.library.updateEntry(e.id, { deletedAt: Date.now() }) },
        ];
    setMenu({ anchor, items });
  };

  const folderMenu = (f: Folder, anchor: { x: number; y: number }) =>
    setMenu({
      anchor,
      items: [
        { label: 'Rename', icon: 'edit-2', onPress: () => setRenameFolder(f) },
        {
          label: 'Delete folder',
          icon: 'trash-2',
          tone: 'bad',
          description: 'Its notebooks move to All notebooks',
          onPress: () => {
            library?.removeFolder(f.id);
            if (filter.kind === 'folder' && filter.id === f.id) setFilter({ kind: 'all' });
          },
        },
      ],
    });

  const navs: { f: LibraryFilter; icon: IconName; label: string; count?: number }[] = [
    { f: { kind: 'all' }, icon: 'book', label: 'All notebooks', count: live.length },
    { f: { kind: 'favorites' }, icon: 'star', label: 'Favorites', count: live.filter((e) => e.favorite).length },
    { f: { kind: 'ai' }, icon: 'cpu', label: 'Shared with AI', count: live.filter((e) => e.aiAccess).length },
    { f: { kind: 'trash' }, icon: 'trash-2', label: 'Recently deleted' },
  ];
  const same = (a: LibraryFilter, b: LibraryFilter) => a.kind === b.kind && (a.kind !== 'folder' || (b.kind === 'folder' && a.id === b.id));
  const accountLabel = s.user ? (s.profile?.email ?? s.profile?.name ?? 'Signed in') : s.serverUrl ? 'Not signed in' : 'On this device';

  const sidebar = (
    // The sidebar's surface runs under the status bar and a landscape display cutout; its content stays in the safe area.
    <View style={[styles.sidebar, { backgroundColor: c.surface, borderRightColor: c.line, width: 260 + insets.left, paddingLeft: 10 + insets.left, paddingTop: 8 + insets.top, paddingBottom: insets.bottom }]}>
      <View style={{ paddingHorizontal: space.sm, paddingTop: space.md, paddingBottom: space.lg }}>
        <Lockup size={18} />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 2, paddingBottom: 12 }}>
        {navs.map((n) => (
          <NavItem key={n.label} icon={n.icon} label={n.label} count={n.count} selected={same(filter, n.f)} onPress={() => setFilter(n.f)} />
        ))}
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 10, paddingTop: space.xl, paddingBottom: space.xxs }}>
          <Text variant="meta" tone="muted" style={{ flex: 1 }}>
            Folders
          </Text>
          <IconButton icon="plus" label="New folder" size={32} onPress={() => setNewFolder(true)} />
        </View>
        {folders.map((f) => (
          <NavItem key={f.id} icon="folder" label={f.name} count={counts.get(f.id) ?? 0} selected={same(filter, { kind: 'folder', id: f.id })} onPress={() => setFilter({ kind: 'folder', id: f.id })} />
        ))}
        {!folders.length ? (
          <Text variant="meta" tone="faint" style={{ paddingHorizontal: 10, paddingVertical: space.xs }}>
            No folders yet
          </Text>
        ) : null}
      </ScrollView>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Settings"
        onPress={() => router.push('/settings')}
        style={(st) => [styles.account, hoverTransition, { borderTopColor: c.line2, backgroundColor: st.pressed ? c.soft : (st as { hovered?: boolean }).hovered ? c.surface2 : 'transparent' }]}
      >
        {s.user ? (
          <Avatar name={s.profile?.email ?? s.profile?.name ?? 'Q'} />
        ) : (
          <View style={[styles.anon, { backgroundColor: c.soft, borderColor: c.line }]}>
            <Icon name="user" size={15} color={c.muted} />
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text variant="label" numberOfLines={1}>
            {accountLabel}
          </Text>
          <Text variant="meta" tone={s.user ? 'good' : 'faint'}>
            {s.user ? 'Sync on' : 'Local only'}
          </Text>
        </View>
        <Icon name="settings" size={18} color={c.muted} />
      </Pressable>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ flex: 1, flexDirection: 'row' }}>
        {wide ? sidebar : null}
        <View style={{ flex: 1, paddingTop: insets.top, paddingRight: insets.right, paddingLeft: wide ? 0 : insets.left }}>
          <View style={[styles.header, !wide && { paddingTop: 8 }]}>
            {!wide ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginRight: -space.sm }}>
                <Lockup size={17} />
                <IconButton icon="settings" label="Settings" onPress={() => router.push('/settings')} />
              </View>
            ) : null}
            <View style={styles.titleRow}>
              <Text variant="display" numberOfLines={1} style={{ flexShrink: 1 }}>
                {filterTitle(filter, folders)}
              </Text>
              <View style={{ flex: 1 }} />
              {filter.kind !== 'trash' ? (
                <Button label="New" icon="plus" variant="primary" onPress={(e) => newMenu({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY + 24 })} />
              ) : null}
            </View>
            <TextField value={query} onChangeText={setQuery} placeholder="Search titles" icon="search" containerStyle={{ maxWidth: 520 }} accessibilityLabel="Search" />
            {!wide ? (
              <ScrollRow style={{ marginHorizontal: -BODY_PAD, paddingHorizontal: BODY_PAD }}>
                {navs.map((n) => (
                  <Chip key={n.label} label={n.label} icon={n.icon} selected={same(filter, n.f)} onPress={() => setFilter(n.f)} />
                ))}
                {folders.map((f) => (
                  <Chip key={f.id} label={f.name} icon="folder" selected={same(filter, { kind: 'folder', id: f.id })} onPress={() => setFilter({ kind: 'folder', id: f.id })} />
                ))}
              </ScrollRow>
            ) : null}
          </View>

          {!library ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator color={c.accent} />
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.body} onLayout={(e) => setGridW(e.nativeEvent.layout.width - 2 * BODY_PAD)}>
              {showFolders ? <SectionLabel style={styles.sectionLabel}>Folders</SectionLabel> : null}
              {showFolders ? (
                <View style={styles.grid}>
                  {folders.map((f) => (
                    <FolderTile
                      key={f.id}
                      folder={f}
                      count={counts.get(f.id) ?? 0}
                      width={Math.max(cardW, Math.min(260, gridW))}
                      onOpen={() => setFilter({ kind: 'folder', id: f.id })}
                      onMenu={(a) => folderMenu(f, a)}
                    />
                  ))}
                </View>
              ) : null}
              {filter.kind === 'folder' ? (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Button label="All notebooks" icon="arrow-left" variant="ghost" size="sm" onPress={() => setFilter({ kind: 'all' })} />
                  <Button
                    label="Folder options"
                    icon="more-horizontal"
                    variant="ghost"
                    size="sm"
                    onPress={(e) => {
                      const f = folders.find((x) => x.id === folderId);
                      if (f) folderMenu(f, { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY + 16 });
                    }}
                  />
                </View>
              ) : null}
              {showFolders && shown.length ? <SectionLabel style={styles.sectionLabel}>Notebooks</SectionLabel> : null}
              {shown.length ? (
                <View style={[styles.grid, { rowGap: space.x3 }]}>
                  {shown.map((e) => (
                    <NotebookCard key={e.id} entry={e} width={cardW} onOpen={() => open(e.id)} onMenu={(a) => entryMenu(e, a)} />
                  ))}
                </View>
              ) : (
                <EmptyState
                  icon={filter.kind === 'trash' ? 'trash-2' : query ? 'search' : 'book'}
                  title={filter.kind === 'trash' ? 'Nothing deleted' : query ? 'No matches' : 'No notebooks yet'}
                  body={
                    filter.kind === 'trash'
                      ? 'Deleted notebooks stay here until you delete them forever.'
                      : query
                        ? 'Try another title.'
                        : 'Create a notebook, or import a PDF to write on it.'
                  }
                  action={
                    filter.kind !== 'trash' && !query ? (
                      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
                        <Button label="New notebook" icon="plus" variant="primary" onPress={() => setNewOpen(true)} />
                        <Button label="Import PDF" icon="upload" onPress={importFile} />
                      </View>
                    ) : undefined
                  }
                />
              )}
            </ScrollView>
          )}
        </View>
      </View>

      {busy ? (
        <Appear from="top" pointerEvents="none" style={[styles.busy, shadow2, { backgroundColor: c.surface, borderColor: c.line }]}>
          <ActivityIndicator color={c.accent} size="small" />
          <Text variant="label">{busy}</Text>
        </Appear>
      ) : null}
      {toast}

      <Menu visible={!!menu} onClose={() => setMenu(null)} items={menu?.items ?? []} anchor={menu?.anchor} />
      <NewNotebookSheet
        visible={newOpen}
        onClose={() => setNewOpen(false)}
        onCreate={async (f) => {
          if (!ctx) return;
          const id = await createNotebook(ctx, f, folderId);
          setNewOpen(false);
          open(id);
        }}
      />
      <CoverSheet
        visible={!!coverFor}
        initial={{ title: coverFor?.title ?? '', cover: coverFor?.cover ?? '' }}
        onClose={() => setCoverFor(null)}
        onSave={(v) => {
          const e = coverFor;
          setCoverFor(null);
          if (e && ctx) void run('Saving…', () => updateNotebookMeta(ctx, e.id, v));
        }}
      />
      <NameSheet
        visible={!!rename}
        title="Rename notebook"
        initial={rename?.title ?? ''}
        placeholder="Title"
        action="Rename"
        onClose={() => setRename(null)}
        onSubmit={(title) => {
          const e = rename;
          setRename(null);
          if (e && ctx) void run('Saving…', () => updateNotebookMeta(ctx, e.id, { title }));
        }}
      />
      <NameSheet
        visible={newFolder || !!renameFolder}
        title={renameFolder ? 'Rename folder' : 'New folder'}
        initial={renameFolder?.name ?? ''}
        placeholder="Folder name"
        action={renameFolder ? 'Rename' : 'Create'}
        onClose={() => {
          setNewFolder(false);
          setRenameFolder(null);
        }}
        onSubmit={(name) => {
          if (renameFolder) library?.renameFolder(renameFolder.id, name);
          else if (library) setFilter({ kind: 'folder', id: library.addFolder(name) });
          setNewFolder(false);
          setRenameFolder(null);
        }}
      />
      <MoveSheet
        visible={!!move}
        folders={folders}
        current={move?.folderId ?? null}
        onClose={() => setMove(null)}
        onMove={(fid) => {
          if (move) library?.updateEntry(move.id, { folderId: fid });
          setMove(null);
        }}
      />
    </View>
  );
}

const BODY_PAD = 24;

const styles = StyleSheet.create({
  sidebar: { width: 260, borderRightWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingTop: 8 },
  nav: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40, paddingHorizontal: 10, borderRadius: 8 },
  anon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  sectionLabel: { paddingTop: 0, paddingBottom: 0, marginBottom: -space.md },
  account: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, marginHorizontal: -10, paddingHorizontal: 18, minHeight: 60, borderTopWidth: StyleSheet.hairlineWidth },
  header: { paddingHorizontal: BODY_PAD, paddingTop: space.xxl, paddingBottom: space.md, gap: space.lg },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  body: { padding: BODY_PAD, paddingTop: 8, gap: 24, flexGrow: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 20 },
  busy: {
    position: 'absolute',
    top: 16,
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
