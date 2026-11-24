import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { InkOverlay, PALM_MAJOR_MM } from 'qalm-ink';
import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DeleteAccountSheet } from '../src/account/DeleteAccountSheet';
import { formatBytes, summarizeUsage, type StorageUsage } from '../src/api/storage';
import { denyRequest, getAiOverview, grantSummary, revokeGrant, toggleId, updateGrant, type AiOverview, type Grant } from '../src/api/ai';
import { rejectedTouchText } from '../src/lib/palm';
import { relativeTime } from '../src/library/actions';
import { useLibraryData, useSession } from '../src/state/session';
import { smoothingLevel, useTheme, type Appearance, type DrawWith, type Hand, type Palm, type PenGesture, type SmoothingPref } from '../src/theme/ThemeProvider';
import { BRAND, PEN_COLORS, radius } from '../src/theme/tokens';
import { Lockup } from '../src/ui/brand';
import { confirm } from '../src/ui/confirm';
import { Avatar, Button, IconButton, Pill, Segmented, Toggle } from '../src/ui/controls';
import { Icon, type IconName } from '../src/ui/Icon';
import { EmptyState, Panel, Row, SectionLabel, useToast } from '../src/ui/layout';
import { Text } from '../src/ui/Text';

type Section = 'account' | 'pen' | 'ai' | 'appearance';
const SECTIONS: { id: Section; label: string; icon: IconName }[] = [
  { id: 'account', label: 'Account and sync', icon: 'user' },
  { id: 'pen', label: 'Pen and palm rejection', icon: 'edit-3' },
  { id: 'ai', label: 'AI access', icon: 'cpu' },
  { id: 'appearance', label: 'Appearance', icon: 'sun' },
];

function AccountSection() {
  const s = useSession();
  const { c } = useTheme();
  const [deleting, setDeleting] = React.useState(false);
  const who = s.profile?.email ?? s.profile?.name ?? (s.user ? 'Signed in' : 'Not signed in');
  return (
    <View style={{ gap: 8 }}>
      <Panel>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 }}>
          <Avatar name={who} size={40} />
          <View style={{ flex: 1 }}>
            <Text variant="bodyStrong">{who}</Text>
            <Text variant="meta">{s.user ? 'Signed in with email' : s.serverUrl ? 'Notebooks stay on this device until you sign in' : 'This build has no sync server'}</Text>
          </View>
          {s.user ? <Pill label="Sync on" tone="good" dot /> : <Pill label="Local only" tone="neutral" />}
        </View>
      </Panel>
      {s.user ? <StorageCard /> : null}
      {s.serverUrl ? (
        <Panel>
          {s.user ? (
            <Row title="Sign out" description="Your notebooks stay in your account. Sign in again to see and sync them.">
              <Button
                label="Sign out"
                variant="danger"
                onPress={() =>
                  confirm('Sign out?', 'Sync stops on this device until you sign in again.', 'Sign out', () => {
                    void s.signOut().then(() => router.replace('/sign-in'));
                  })
                }
              />
            </Row>
          ) : null}
          {s.user ? (
            <Row title="Delete account" description="Deletes your account and everything in it, on every device. We'll email you a code to confirm." last>
              <Button label="Delete account…" variant="danger" onPress={() => setDeleting(true)} />
            </Row>
          ) : (
            <Row title="Sign in to sync" description="We email you a sign-in link and a code. Notebooks you made here come with you." last>
              <Button label="Sign in" variant="primary" onPress={() => router.push('/sign-in')} />
            </Row>
          )}
        </Panel>
      ) : null}
      <Text variant="meta" tone="faint" style={{ paddingHorizontal: 4, color: c.faint }}>
        {BRAND.systemName} · free while in beta
      </Text>
      <DeleteAccountSheet visible={deleting} onClose={() => setDeleting(false)} />
    </View>
  );
}

/** Settings → Account: how much of the account's storage (PDFs, images and notebook data) is used. */
function StorageCard() {
  const s = useSession();
  const { c } = useTheme();
  const [usage, setUsage] = React.useState<StorageUsage | null>(null);
  const [failed, setFailed] = React.useState(false);
  const load = React.useCallback(() => {
    setFailed(false);
    s.assets
      .storage()
      .then((u) => setUsage(u))
      .catch(() => setFailed(true));
  }, [s.assets]);
  React.useEffect(load, [load, s.user?.id]);

  const sum = usage ? summarizeUsage(usage) : null;
  const fill = sum?.warn ? c.warn : c.accent;
  return (
    <Panel>
      <View style={{ padding: 16, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
          <Text variant="bodyStrong">Storage</Text>
          {sum ? (
            <Text variant="smallStrong" style={{ color: sum.warn ? c.warn : c.ink2 }} accessibilityLabel={`Storage: ${sum.label} used`}>
              {sum.label}
            </Text>
          ) : failed ? null : (
            <ActivityIndicator size="small" color={c.faint} />
          )}
        </View>
        <View
          style={[styles.track, { backgroundColor: c.line2 }]}
          accessibilityRole="progressbar"
          accessibilityValue={sum ? { min: 0, max: 100, now: Math.round(sum.fraction * 100) } : undefined}
        >
          {sum ? <View style={[styles.fill, { backgroundColor: fill, width: `${Math.max(sum.fraction > 0 ? 1 : 0, sum.fraction * 100)}%` }]} /> : null}
        </View>
        {failed ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <Text variant="meta">Couldn't load your storage. Check your connection.</Text>
            <Button label="Retry" variant="ghost" size="sm" onPress={load} />
          </View>
        ) : usage ? (
          <Text variant="meta">
            PDFs and images {formatBytes(usage.assetBytes)} · Notebooks {formatBytes(usage.notebookBytes)}
          </Text>
        ) : null}
        {sum?.full ? (
          <View style={[styles.storageNote, { backgroundColor: c.warnSoft, borderColor: c.line }]}>
            <Icon name="alert-triangle" size={14} color={c.warn} />
            <Text variant="small" style={{ color: c.warn, flex: 1 }}>
              Your storage is full. New PDF and image imports are paused; handwriting and text keep syncing. Delete PDFs or images you don't need to make room.
            </Text>
          </View>
        ) : sum?.warn ? (
          <View style={[styles.storageNote, { backgroundColor: c.warnSoft, borderColor: c.line }]}>
            <Icon name="info" size={14} color={c.warn} />
            <Text variant="small" style={{ color: c.warn, flex: 1 }}>
              You've used over 90% of your {formatBytes(usage!.limitBytes)}. At the limit, new PDF and image imports stop; handwriting always keeps syncing.
            </Text>
          </View>
        ) : null}
      </View>
    </Panel>
  );
}

function PenSection() {
  const { c, input, setInput } = useTheme();
  const [rejected, setRejected] = React.useState<string | null>(null);
  return (
    <View style={{ gap: 8 }}>
      <Panel>
        <Row title="Draw with" description={input.drawWith === 'pen' ? 'Fingers scroll and zoom; only the pen draws' : 'Pen and fingers both draw'}>
          <Segmented<DrawWith>
            value={input.drawWith}
            onChange={(drawWith) => setInput({ drawWith })}
            options={[
              { value: 'pen', label: 'Pen only' },
              { value: 'any', label: 'Pen and finger' },
            ]}
          />
        </Row>
        <Row title="Writing hand" description="Touches beside and below the pen on this side are ignored">
          <Segmented<Hand>
            value={input.hand}
            onChange={(hand) => setInput({ hand })}
            options={[
              { value: 'left', label: 'Left' },
              { value: 'right', label: 'Right' },
            ]}
          />
        </Row>
        <Row title="Palm rejection" description={`Fingertips write; contacts wider than ${PALM_MAJOR_MM[input.palm]} mm are a palm`}>
          <Segmented<Palm>
            value={input.palm}
            onChange={(palm) => setInput({ palm })}
            options={[
              { value: 'relaxed', label: 'Relaxed', detail: `${PALM_MAJOR_MM.relaxed} mm` },
              { value: 'standard', label: 'Standard', detail: `${PALM_MAJOR_MM.standard} mm` },
              { value: 'strict', label: 'Strict', detail: `${PALM_MAJOR_MM.strict} mm` },
            ]}
          />
        </Row>
        <Row title="Stroke smoothing" description="Evens out shaky lines. Applies to new pen strokes">
          <Segmented<SmoothingPref>
            value={input.smoothing}
            onChange={(smoothing) => setInput({ smoothing })}
            options={[
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
            ]}
          />
        </Row>
        <Row title="Pen button, squeeze or double-tap" description="What the pen's shortcut does" last>
          <Segmented<PenGesture>
            value={input.penGesture}
            onChange={(penGesture) => setInput({ penGesture })}
            options={[
              { value: 'eraser', label: 'Eraser' },
              { value: 'last', label: 'Last tool' },
              { value: 'none', label: 'Nothing' },
            ]}
          />
        </Row>
      </Panel>
      <SectionLabel>Test area</SectionLabel>
      <View style={[styles.pad, { borderColor: c.line }]}>
        <Text variant="meta" style={{ position: 'absolute', left: 12, top: 10, color: '#8b8b95' }}>
          Write with a finger or the pen, and rest your palm here
        </Text>
        <InkOverlay
          pageSize={{ w: 600, h: 200 }}
          tool="pen"
          color={PEN_COLORS[0].hex}
          width={1.8}
          smoothing={smoothingLevel(input.smoothing)}
          input={input}
          committedIds={[]}
          onStrokeEnd={() => setRejected(null)}
          onErase={() => undefined}
          onLasso={() => undefined}
          onRejectedTouch={({ nativeEvent }) => setRejected(nativeEvent.reason)}
        />
      </View>
      <Text variant="meta" tone={rejected ? 'bad' : 'faint'} style={{ paddingHorizontal: 4 }}>
        {rejected ? rejectedTouchText(rejected) : 'Strokes here fade after a few seconds.'}
      </Text>
    </View>
  );
}

function GrantCard({ g, onChange, onRevoke }: { g: Grant; onChange(next: Grant): void; onRevoke(): void }) {
  const { c } = useTheme();
  const s = useSession();
  const { entries, folders } = useLibraryData();
  const [open, setOpen] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const notebooks = entries.filter((e) => !e.deletedAt);
  const scope = [
    ...g.folderIds.map((id) => `Folder: ${folders.find((f) => f.id === id)?.name ?? 'Folder'}`),
    ...g.notebookIds.map((id) => entries.find((e) => e.id === id)?.title ?? 'Notebook'),
  ];
  const patch = async (p: Parameters<typeof updateGrant>[2]) => {
    if (!s.tm) return;
    setErr(null);
    onChange({ ...g, ...p });
    try {
      onChange(await updateGrant(s.tm, g.id, p));
    } catch (e) {
      onChange(g);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Panel>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}>
        <Avatar name={g.clientName} kind="agent" size={34} />
        <View style={{ flex: 1 }}>
          <Text variant="bodyStrong">{g.clientName}</Text>
          <Text variant="meta" numberOfLines={2}>
            {scope.length ? scope.join(', ') : 'No notebooks'} · {g.lastUsedAt ? `active ${relativeTime(g.lastUsedAt).toLowerCase()}` : 'not used yet'}
          </Text>
        </View>
        <Pill label={grantSummary(g)} tone="assistant" />
        <IconButton icon={open ? 'chevron-up' : 'chevron-down'} label={open ? 'Hide' : 'Manage'} size={36} onPress={() => setOpen((x) => !x)} />
      </View>
      {open ? (
        <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line2 }}>
          <Row title="Leave comments" description="Pinned next to your ink. Never changes ink">
            <Toggle label="Leave comments" value={g.canComment} onChange={(v) => void patch({ canComment: v })} />
          </Row>
          <Row title="Save readings" description="Stores what it reads in your handwriting. You can edit it under Reading">
            <Toggle label="Save readings" value={g.canTranscribe} onChange={(v) => void patch({ canTranscribe: v })} />
          </Row>
          <SectionLabel style={{ paddingHorizontal: 16 }}>Notebooks it can see</SectionLabel>
          {notebooks.length === 0 ? (
            <Text variant="meta" style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
              No notebooks yet.
            </Text>
          ) : (
            notebooks.map((e) => {
              const viaFolder = !!e.folderId && g.folderIds.includes(e.folderId);
              const on = viaFolder || g.notebookIds.includes(e.id);
              return (
                <Row key={e.id} title={e.title || 'Untitled notebook'} description={viaFolder ? 'Included through its folder' : undefined}>
                  <Toggle label={e.title} value={on} disabled={viaFolder} onChange={(v) => void patch({ notebookIds: toggleId(g.notebookIds, e.id, v) })} />
                </Row>
              );
            })
          )}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14, gap: 12 }}>
            <Text variant="meta" tone="faint">
              Expires {new Date(g.expiresAt).toLocaleDateString()}
            </Text>
            <Button
              label="Disconnect"
              variant="danger"
              size="sm"
              onPress={() => confirm(`Disconnect ${g.clientName}?`, 'It loses access straight away.', 'Disconnect', onRevoke)}
            />
          </View>
          {err ? (
            <Text variant="meta" tone="bad" style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
              {err}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Panel>
  );
}

function AiSection() {
  const s = useSession();
  const { c } = useTheme();
  const [data, setData] = React.useState<AiOverview | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [toast, showToast] = useToast();
  const load = React.useCallback(async () => {
    if (!s.tm || !s.user) return;
    setErr(null);
    try {
      setData(await getAiOverview(s.tm));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [s.tm, s.user]);
  React.useEffect(() => {
    void load();
  }, [load]);

  if (!s.serverUrl || !s.user) {
    return (
      <Panel>
        <EmptyState
          icon="cpu"
          title="Sign in to connect an agent"
          body="Agents connect over MCP to the notebooks you pick. They can read and comment, but never change your ink."
          action={s.serverUrl ? <Button label="Sign in" variant="primary" onPress={() => router.push('/sign-in')} /> : undefined}
        />
      </Panel>
    );
  }
  const mcpUrl = data?.mcpUrl ?? `${s.serverUrl}/mcp`;
  return (
    <View style={{ gap: 8 }}>
      <Text tone="muted">Agents connect over MCP. They can read the notebooks you pick and leave comments. They can never change your ink.</Text>
      {data?.pending.map((p) => (
        <View key={p.id} style={[styles.pending, { backgroundColor: c.warnSoft, borderColor: c.line }]}>
          <Avatar name={p.clientName} kind="agent" size={30} />
          <View style={{ flex: 1 }}>
            <Text variant="label">{p.clientName} wants to connect</Text>
            <Text variant="meta">
              {p.redirectHost} · {relativeTime(p.createdAt).toLowerCase()} · approve it in the window that opened
            </Text>
          </View>
          <Button
            label="Deny"
            size="sm"
            variant="danger"
            onPress={() =>
              void denyRequest(s.tm!, p.id)
                .then(load)
                .catch((e: unknown) => showToast(String(e)))
            }
          />
        </View>
      ))}
      <SectionLabel>Connect an agent</SectionLabel>
      <Panel>
        <View style={{ padding: 14, gap: 10 }}>
          <View style={[styles.url, { backgroundColor: c.surface2, borderColor: c.line }]}>
            <Text variant="mono" style={{ flex: 1 }} numberOfLines={1} selectable>
              {mcpUrl}
            </Text>
            <Button
              label="Copy"
              icon="copy"
              size="sm"
              onPress={() => void Clipboard.setStringAsync(mcpUrl).then(() => showToast('Copied'))}
            />
          </View>
          <Text variant="meta">Add this address as a remote MCP server in Claude, Cursor or your own agent. You'll approve it in your browser.</Text>
        </View>
      </Panel>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <SectionLabel style={{ flex: 1 }}>Connected · {data?.grants.length ?? 0}</SectionLabel>
        <IconButton icon="refresh-cw" label="Refresh" size={36} onPress={() => void load()} />
      </View>
      {!data && !err ? <ActivityIndicator color={c.accent} /> : null}
      {err ? (
        <Text variant="label" tone="bad">
          {err}
        </Text>
      ) : null}
      {data && !data.grants.length ? (
        <Text variant="meta" style={{ paddingHorizontal: 4 }}>
          No agents connected yet.
        </Text>
      ) : null}
      {data?.grants.map((g) => (
        <GrantCard
          key={g.id}
          g={g}
          onChange={(next) => setData((d) => (d ? { ...d, grants: d.grants.map((x) => (x.id === g.id ? next : x)) } : d))}
          onRevoke={() =>
            void revokeGrant(s.tm!, g.id)
              .then(load)
              .catch((e: unknown) => showToast(String(e)))
          }
        />
      ))}
      {data?.activity.length ? (
        <>
          <SectionLabel>Activity</SectionLabel>
          <Panel>
            {data.activity.map((a, i) => (
              <View key={i} style={[styles.log, i < data.activity.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line2 }]}>
                <Text variant="mono" tone="faint" style={{ width: 52 }}>
                  {new Date(a.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                </Text>
                <Text variant="mono" style={{ flex: 1 }} numberOfLines={2}>
                  {a.clientName} · {a.tool} · {a.target}
                </Text>
                {a.tokens ? (
                  <Text variant="mono" tone="faint">
                    {a.tokens} tok
                  </Text>
                ) : null}
              </View>
            ))}
          </Panel>
        </>
      ) : null}
      {toast}
    </View>
  );
}

function AppearanceSection() {
  const { appearance, setAppearance } = useTheme();
  return (
    <Panel>
      <Row title="Theme" description="Pages stay paper-coloured in every theme" last>
        <Segmented<Appearance>
          value={appearance}
          onChange={setAppearance}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </Row>
    </Panel>
  );
}

export default function Settings() {
  const { c } = useTheme();
  const win = useWindowDimensions();
  const wide = win.width >= 820;
  const [section, setSection] = React.useState<Section>('account');
  const [picked, setPicked] = React.useState(wide);
  const showNav = wide || !picked;
  const showBody = wide || picked;
  const title = SECTIONS.find((x) => x.id === section)!.label;
  const insets = useSafeAreaInsets();

  const back = () => {
    if (!wide && picked) setPicked(false);
    else if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      {/* The header's surface runs under the status bar and a landscape display cutout; its controls stay in the safe area. */}
      <View
        style={[
          styles.header,
          { backgroundColor: c.surface, borderBottomColor: c.line, paddingTop: insets.top, paddingLeft: 6 + insets.left, paddingRight: 6 + insets.right, minHeight: 56 + insets.top },
        ]}
      >
        <IconButton icon="chevron-left" label="Back" onPress={back} />
        <Text variant="section" style={{ flex: 1 }}>
          {showBody && !wide ? title : 'Settings'}
        </Text>
      </View>
      <View style={{ flex: 1, flexDirection: 'row', paddingRight: insets.right }}>
        {showNav ? (
          <View style={[wide ? styles.nav : { flex: 1, padding: 16 }, { paddingLeft: (wide ? 10 : 16) + insets.left }, wide && { width: 260 + insets.left, borderRightColor: c.line, backgroundColor: c.surface }]}>
            {SECTIONS.map((x) => {
              const on = wide && x.id === section;
              return (
                <Pressable
                  key={x.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => {
                    setSection(x.id);
                    setPicked(true);
                  }}
                  style={(st) => [styles.navItem, { backgroundColor: on ? c.accentSoft : (st as { hovered?: boolean }).hovered || st.pressed ? c.soft : 'transparent' }]}
                >
                  <Icon name={x.icon} size={17} color={on ? c.accentInk : c.muted} />
                  <Text variant="label" style={{ flex: 1, color: on ? c.accentInk : c.ink2 }}>
                    {x.label}
                  </Text>
                  {!wide ? <Icon name="chevron-right" size={16} color={c.faint} /> : null}
                </Pressable>
              );
            })}
            {wide ? (
              <View style={{ marginTop: 'auto', padding: 10 }}>
                <Lockup size={15} />
              </View>
            ) : null}
          </View>
        ) : null}
        {showBody ? (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.body}>
            <View style={{ width: '100%', maxWidth: 720, gap: 12 }}>
              {wide ? <Text variant="title">{title}</Text> : null}
              {section === 'account' ? <AccountSection /> : null}
              {section === 'pen' ? <PenSection /> : null}
              {section === 'ai' ? <AiSection /> : null}
              {section === 'appearance' ? <AppearanceSection /> : null}
            </View>
          </ScrollView>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: 4, borderRadius: radius.pill, overflow: 'hidden' },
  fill: { height: 4, borderRadius: radius.pill },
  storageNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 10, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth },
  nav: { width: 260, padding: 10, gap: 2, borderRightWidth: StyleSheet.hairlineWidth },
  navItem: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 10, borderRadius: radius.control },
  body: { padding: 24, alignItems: 'center' },
  pad: { height: 200, borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth, backgroundColor: '#ffffff', overflow: 'hidden' },
  pending: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth },
  url: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 12, paddingRight: 4, minHeight: 44, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth },
  log: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
});


