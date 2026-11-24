/**
 * Lecture mode in the editor (docs/lecture-mode.md): the Record controls, the paused banner (the pen is locked), the
 * Lectures list, the player bar with the transcript, replayed ink, and the export choice. EditorScreen mounts this
 * through `useLectureEditor` so its own changes stay small.
 */
import { fmtT, LectureDoc, lectureDocId, Page, type Item, type LectureSummary, type Notebook, type PageInfo } from '@qalm/core';
import * as React from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { exportNotebook } from '../library/ops';
import { openLoaded, docIds } from '../sync/docs';
import { removeLocalDoc } from '../sync/persistence';
import { useSession, useVersion } from '../state/session';
import { useTheme } from '../theme/ThemeProvider';
import { radius } from '../theme/tokens';
import { confirm } from '../ui/confirm';
import { Button, IconButton, Pill, Toggle } from '../ui/controls';
import { Row, Sheet, type MenuItem } from '../ui/layout';
import { Text } from '../ui/Text';
import { holdAiWhileRecording } from './aiHold';
import { LecturePlayback, SPEEDS } from './playback';
import { createChunkPlayer } from './player';
import { useLecturePrefs } from './prefs';
import { chunkUri, currentRecorder, lectureAssetBytes, retrySessionTranscription, startRecording, useFailedTranscriptions, useRecorder, useRecorderClock } from './store';
import { dropQueuedSession } from './transcribe';

/** What PageView needs: the pen lock and, during playback, the replayed ink and tap-to-seek. */
export interface LectureCtx {
  /** Paused (or replaying): no strokes, no edits. */
  locked: boolean;
  /** Replayed items per page while a session plays (pages it never touched draw as they are). */
  replay: Map<string, Item[]> | null;
  /** A tap on a page during playback (page coordinates; tolerance in page units). */
  tapAt(pageId: string, x: number, y: number, tol: number): void;
}

interface Args {
  notebookId: string;
  /** The open notebook's Play / Pause AI hold (`useAiLive().holdWhileBackgrounded`): taken while recording here. */
  holdAi?: (reason: string) => () => void;
  notebook: Notebook;
  pages: PageInfo[];
  current: number;
  jumpTo(index: number): void;
  showToast(msg: string): void;
  run(label: string, fn: () => Promise<void>): void;
}

const dateLabel = (t: number) =>
  new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function useLectureEditor({ notebookId, holdAi, notebook, pages, current, jumpTo, showToast, run }: Args) {
  const s = useSession();
  const prefs = useLecturePrefs();
  const signedIn = !!s.user && !!s.tm;
  const enabled = prefs.enabled && signedIn;
  const { rec } = useRecorder();
  const here = rec?.notebookId === notebookId && rec.active;
  const state = here ? rec!.state : 'idle';

  // Sessions of this notebook (the library's list).
  const lib = s.library;
  const libSub = React.useMemo(() => (lib ? (cb: () => void) => lib.observe(cb) : null), [lib]);
  const libV = useVersion(libSub);
  const sessions = React.useMemo(() => lib?.lectures(notebookId) ?? [], [lib, notebookId, libV]);

  // Recording here keeps AI sharing on in the background (owner decision); pause or stop releases it.
  React.useEffect(() => {
    if (!here || !rec || !holdAi) return;
    return holdAiWhileRecording(rec, holdAi);
  }, [here, rec, holdAi]);

  // The page in view is logged while recording.
  const pageId = pages[current]?.id;
  React.useEffect(() => {
    if (here && pageId) rec!.showPage(pageId, current + 1);
  }, [here, pageId, current, rec]);

  // ---- playback ----
  // The editor re-renders only when the replayed ink changes (a stroke appears or goes), never on the clock's ticks:
  // the time, scrubber and transcript live in PlayerBar, which subscribes on its own.
  const [pb, setPb] = React.useState<LecturePlayback | null>(null);
  const [replay, setReplay] = React.useState<Map<string, Item[]> | null>(null);
  const follow = React.useRef({ pages, current, jumpTo });
  follow.current = { pages, current, jumpTo };
  React.useEffect(() => {
    if (!pb) {
      setReplay(null);
      return;
    }
    let prev: Map<string, Item[]> | null = null;
    let followed: string | null = null;
    const update = () => {
      const next = pb.items();
      if (!(prev && prev.size === next.size && [...next].every(([k, v]) => prev!.get(k) === v))) {
        prev = next;
        setReplay(next);
      }
      if (!pb.playing) return;
      const p = pb.pageNow();
      if (p && p !== followed) {
        followed = p;
        const f = follow.current;
        const i = f.pages.findIndex((x) => x.id === p);
        if (i >= 0 && i !== f.current) f.jumpTo(i);
      }
    };
    update();
    const off = pb.subscribe(update);
    return () => {
      off();
      pb.close();
    };
  }, [pb]);

  const openSession = (sess: LectureSummary) =>
    run('Opening recording…', async () => {
      if (rec?.active) throw new Error('Stop the recording first');
      pb?.close();
      const p = new LecturePlayback({
        openDoc: async (docId) => {
          const h = await openLoaded(s.dm, docId, 3000);
          return { doc: h.doc, release: () => h.release() };
        },
        pageItems: async (pid) => {
          const h = await openLoaded(s.dm, docIds.page(notebookId, pid), 3000);
          try {
            return new Page(h.doc).items();
          } finally {
            h.release();
          }
        },
        audioUri: (c) => chunkUri(s, c.sha, c.mime),
        player: createChunkPlayer,
      });
      await p.load(notebookId, sess.id);
      setPb(p);
      setListOpen(false);
    });

  const closePlayer = () => {
    pb?.close();
    setPb(null);
  };

  const ctx = React.useMemo<LectureCtx>(
    () => ({
      locked: (here && rec!.penLocked) || !!pb,
      replay,
      tapAt: (pid, x, y, tol) => void pb?.tapAt(pid, x, y, tol),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [here, state, pb, replay],
  );

  const attachPage = React.useCallback(
    (pid: string, page: Page | null) => {
      const r = rec;
      if (r && (r.notebookId === notebookId || !r.active)) r.attachPage(pid, page);
    },
    [rec, notebookId],
  );
  // Pages already open when recording starts are logged too: remember them for the next recorder.
  const openPages = React.useRef(new Map<string, Page>());
  const attach = React.useCallback(
    (pid: string, page: Page | null) => {
      if (page) openPages.current.set(pid, page);
      else openPages.current.delete(pid);
      attachPage(pid, page);
    },
    [attachPage],
  );

  const record = () =>
    void (async () => {
      try {
        if (pb) closePlayer();
        await startRecording(s, notebookId, pageId ? { id: pageId, n: current + 1 } : null, (e) => showToast(e instanceof Error ? e.message : String(e)));
        const r = currentRecorder();
        // The recorder starts its log after start(): hand it the pages already open.
        for (const [pid, page] of openPages.current) r?.attachPage(pid, page);
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
      }
    })();

  // ---- lists and sheets ----
  const failed = useFailedTranscriptions(s.user?.id ?? null);
  const [listOpen, setListOpen] = React.useState(false);
  const [exportAsk, setExportAsk] = React.useState<null | { include: boolean }>(null);

  const deleteSession = (sess: LectureSummary) => {
    // The recording in progress can't be deleted (stopping it would put it back in the library): stop it first.
    if (rec?.active && rec.sessionId === sess.id) return showToast('Stop the recording first, then delete it');
    return confirm('Delete this recording?', `${dateLabel(sess.startedAt)} · ${fmtT(sess.durationMs)}. Its audio, transcript and replay are deleted on all your devices. Your notes stay.`, 'Delete', () =>
      run('Deleting…', async () => {
        if (pb) closePlayer();
        // Queued transcriptions of it go first: one finishing later would write into it and bring it back.
        if (s.user) await dropQueuedSession(s.user.id, sess.id).catch(() => undefined);
        const docId = lectureDocId(notebookId, sess.id);
        // So are its audio uploads still queued (they'd count against storage with nothing using them).
        const shas = await openLoaded(s.dm, docId, 0)
          .then((h) => {
            try {
              return new LectureDoc(h.doc).audio().map((a) => a.sha);
            } finally {
              h.release();
            }
          })
          .catch(() => [] as string[]);
        await s.assets.dropPending(shas, docId).catch(() => undefined);
        const res = await s.tm?.fetch(`/lectures/${encodeURIComponent(notebookId)}/${encodeURIComponent(sess.id)}`, { method: 'DELETE' }).catch(() => null);
        if (!res || (!res.ok && res.status !== 404)) throw new Error('Couldn’t reach the server. Try again when you’re online.');
        await s.dm.drop(docId);
        await removeLocalDoc(docId).catch(() => undefined);
        lib?.removeLecture(sess.id);
      }),
    );
  };

  const menuItems: MenuItem[] = sessions.length || enabled ? [{ label: `Lectures${sessions.length ? ` (${sessions.length})` : ''}`, icon: 'mic', onPress: () => setListOpen(true) }] : [];

  /** "Export .qalm backup": asks about lecture recordings first when there are any. */
  const exportQalm = () => {
    if (!sessions.some((x) => x.state === 'stopped')) return run('Exporting…', () => exportNotebook({ dm: s.dm, assets: s.assets }, notebookId, 'qalm'));
    setExportAsk({ include: false });
  };
  const doExport = (include: boolean) => {
    setExportAsk(null);
    run('Exporting…', () =>
      exportNotebook({ dm: s.dm, assets: s.assets }, notebookId, 'qalm', include ? { lectures: sessions.filter((x) => x.state === 'stopped').map((x) => x.id), assetBytes: (sha, mime) => lectureAssetBytes(s, sha, mime) } : undefined),
    );
  };

  const header = enabled || here ? <RecordControls rec={here ? rec : null} otherActive={!!rec?.active && !here} onRecord={record} /> : null;

  const overlay = (
    <>
      {here && state === 'paused' ? <PausedBanner onResume={() => void rec!.resume()} /> : null}
      {pb ? <PlayerBar pb={pb} onClose={closePlayer} /> : null}
      <Sheet visible={listOpen} onClose={() => setListOpen(false)} title="Lectures">
        {sessions.length ? (
          <View>
            {sessions.map((x, i) => (
              <Row
                key={x.id}
                title={dateLabel(x.startedAt)}
                description={`${fmtT(x.durationMs)}${x.state !== 'stopped' ? ` · ${x.state}` : ''}${failed.get(x.id) ? ' · transcription failed' : ''}`}
                last={i === sessions.length - 1}
              >
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {failed.get(x.id) ? (
                    <Button label="Retry" icon="refresh-cw" size="sm" variant="ghost" accessibilityLabel="Retry transcription" onPress={() => run('Transcribing…', () => retrySessionTranscription(s, x.id))} />
                  ) : null}
                  <Button label="Play" icon="play" size="sm" testID={`lecture-play-${i}`} disabled={x.state !== 'stopped'} onPress={() => openSession(x)} />
                  <IconButton
                    icon="trash-2"
                    label={rec?.active && rec.sessionId === x.id ? 'Stop the recording to delete it' : 'Delete recording'}
                    tone="bad"
                    size={36}
                    disabled={!!rec?.active && rec.sessionId === x.id}
                    onPress={() => deleteSession(x)}
                  />
                </View>
              </Row>
            ))}
          </View>
        ) : (
          <Text tone="muted">{enabled ? 'No recordings yet. Tap Record to record a lecture: audio, every stroke and a transcript.' : 'Turn on lecture mode in Settings to record.'}</Text>
        )}
      </Sheet>
      <Sheet
        visible={!!exportAsk}
        onClose={() => setExportAsk(null)}
        title="Export .qalm backup"
        footer={
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
            <Button label="Cancel" variant="ghost" onPress={() => setExportAsk(null)} />
            <Button label="Export" variant="primary" testID="lecture-export-go" onPress={() => doExport(!!exportAsk?.include)} />
          </View>
        }
      >
        <Row title="Include lecture recordings" description="Adds each recording's audio, timeline, crops and transcript. The file gets much larger." last>
          <Toggle label="Include lecture recordings" value={!!exportAsk?.include} onChange={(v) => setExportAsk({ include: v })} />
        </Row>
      </Sheet>
    </>
  );

  // Presenting (#70): the overlay (banner, player, sheets) is hidden; a recording shows only as a small dot and time.
  const presentIndicator = here ? <RecordingDot rec={rec!} /> : null;

  return { ctx, attachPage: attach, header, overlay, presentIndicator, menuItems, exportQalm, playing: !!pb, sessions };
}

/** The Record button, or the running recording: its own clock subscription, so only this re-renders 4× a second. */
function RecordControls({ rec, otherActive, onRecord }: { rec: ReturnType<typeof useRecorder>['rec']; otherActive: boolean; onRecord(): void }) {
  const { c } = useTheme();
  const t = useRecorderClock(rec);
  if (otherActive) return <Pill label="Recording elsewhere" tone="bad" dot />;
  if (!rec || rec.state === 'idle' || rec.state === 'starting') {
    return <Button label={rec?.state === 'starting' ? 'Starting…' : 'Record'} icon="mic" size="sm" testID="lecture-record" disabled={rec?.state === 'starting'} onPress={onRecord} />;
  }
  const paused = rec.state === 'paused' || rec.state === 'pausing';
  const busy = rec.state !== 'recording' && rec.state !== 'paused'; // pausing, resuming, stopping
  return (
    <View style={[styles.rec, { borderColor: c.line, backgroundColor: paused ? c.surface2 : c.badSoft }]} accessibilityRole="timer" accessibilityLabel={`${paused ? 'Recording paused' : 'Recording'}, ${fmtT(t)}`}>
      <View style={[styles.dot, { backgroundColor: paused ? c.muted : c.bad }]} />
      <Text variant="meta" testID="lecture-time" style={{ fontVariant: ['tabular-nums'], minWidth: 40 }}>
        {fmtT(t)}
      </Text>
      {paused ? (
        <IconButton icon="play" label="Resume recording" size={36} testID="lecture-resume" disabled={busy} onPress={() => void rec.resume()} />
      ) : (
        <IconButton icon="pause" label="Pause recording" size={36} testID="lecture-pause" disabled={busy} onPress={() => void rec.pause()} />
      )}
      <IconButton icon="square" label="Stop recording" size={36} testID="lecture-stop" disabled={rec.state === 'stopping'} onPress={() => void rec.stop()} />
    </View>
  );
}

/** While presenting: a small, non-interactive mark that a lecture is recording (red, with the time) or paused. */
function RecordingDot({ rec }: { rec: NonNullable<ReturnType<typeof useRecorder>['rec']> }) {
  const { c } = useTheme();
  const t = useRecorderClock(rec);
  const recording = rec.state === 'recording';
  return (
    <View pointerEvents="none" style={styles.dotWrap} testID="lecture-present-indicator" accessibilityLabel={recording ? `Recording, ${fmtT(t)}` : 'Recording paused'}>
      <View style={[styles.dotPill, { backgroundColor: c.surface, borderColor: c.line }]}>
        <View style={[styles.dot, { backgroundColor: recording ? c.bad : c.muted }]} />
        <Text variant="meta" style={{ fontVariant: ['tabular-nums'] }}>
          {recording ? fmtT(t) : 'Paused'}
        </Text>
      </View>
    </View>
  );
}

function PausedBanner({ onResume }: { onResume(): void }) {
  const { c } = useTheme();
  return (
    <View pointerEvents="box-none" style={styles.bannerWrap}>
      <View testID="lecture-paused-banner" style={[styles.banner, { backgroundColor: c.surface, borderColor: c.line }]} accessibilityRole="alert">
        <View style={[styles.dot, { backgroundColor: c.muted }]} />
        <Text variant="bodyStrong">Recording paused · resume to write</Text>
        <Button label="Resume" icon="mic" size="sm" variant="primary" onPress={onResume} />
      </View>
    </View>
  );
}

/** The player: subscribes to the playback itself (20× a second while playing); the editor around it doesn't. */
function PlayerBar({ pb, onClose }: { pb: LecturePlayback; onClose(): void }) {
  const { c } = useTheme();
  const sub = React.useMemo(() => (cb: () => void) => pb.subscribe(cb), [pb]);
  useVersion(sub);
  const insets = useSafeAreaInsets();
  const [showText, setShowText] = React.useState(true);
  const [w, setW] = React.useState(1);
  const line = pb.lineNow();
  const scroll = React.useRef<React.ComponentRef<typeof ScrollView>>(null);
  const rows = React.useRef(new Map<number, number>());
  React.useEffect(() => {
    const y = rows.current.get(line);
    if (y !== undefined) scroll.current?.scrollTo({ y: Math.max(0, y - 60), animated: true });
  }, [line]);
  const frac = pb.duration ? pb.t / pb.duration : 0;
  const seekAt = (x: number) => void pb.seek((Math.max(0, Math.min(w, x)) / w) * pb.duration);
  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { justifyContent: 'flex-end' }]}>
      {showText && pb.transcript.length ? (
        <View style={[styles.transcript, { backgroundColor: c.surface, borderColor: c.line }]} testID="lecture-transcript">
          <ScrollView ref={scroll} contentContainerStyle={{ padding: 8 }}>
            {pb.transcript.map((seg, i) => (
              <Pressable
                key={i}
                accessibilityRole="button"
                accessibilityLabel={`${fmtT(seg.t0)}: ${seg.text}`}
                onLayout={(e: LayoutChangeEvent) => rows.current.set(i, e.nativeEvent.layout.y)}
                onPress={() => void pb.seek(seg.t0)}
                style={[styles.line, i === line && { backgroundColor: c.accentSoft }]}
              >
                <Text variant="meta" tone="faint" style={{ width: 44, fontVariant: ['tabular-nums'] }}>
                  {fmtT(seg.t0)}
                </Text>
                <Text style={{ flex: 1 }}>{seg.text}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
      <View testID="lecture-player" style={[styles.player, { backgroundColor: c.surface, borderColor: c.line, marginBottom: 12 + insets.bottom }]}>
        <IconButton icon={pb.playing ? 'pause' : 'play'} label={pb.playing ? 'Pause' : 'Play'} testID="lecture-playpause" onPress={() => (pb.playing ? pb.pause() : void pb.play())} />
        <Text variant="meta" testID="lecture-position" style={{ fontVariant: ['tabular-nums'] }}>
          {fmtT(pb.t)} / {fmtT(pb.duration)}
        </Text>
        <View
          style={styles.track}
          onLayout={(e) => setW(Math.max(1, e.nativeEvent.layout.width))}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={(e) => seekAt(e.nativeEvent.locationX)}
          onResponderMove={(e) => seekAt(e.nativeEvent.locationX)}
          accessibilityRole="adjustable"
          accessibilityLabel="Position"
          accessibilityValue={{ min: 0, max: Math.round(pb.duration / 1000), now: Math.round(pb.t / 1000), text: fmtT(pb.t) }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => void pb.seek(pb.t + (e.nativeEvent.actionName === 'increment' ? 10_000 : -10_000))}
        >
          <View pointerEvents="none" style={[styles.rail, { backgroundColor: c.line }]} />
          <View pointerEvents="none" style={[styles.fill, { backgroundColor: c.accent, width: `${frac * 100}%` }]} />
          <View pointerEvents="none" style={[styles.knob, { backgroundColor: c.accent, left: Math.max(0, frac * w - 7) }]} />
        </View>
        <Button
          label={`${pb.rate}×`}
          size="sm"
          variant="ghost"
          accessibilityLabel={`Speed ${pb.rate}×`}
          onPress={() => pb.setRate(SPEEDS[(SPEEDS.indexOf(pb.rate) + 1) % SPEEDS.length]!)}
        />
        <IconButton icon="align-left" label="Transcript" selected={showText} onPress={() => setShowText((x) => !x)} />
        <IconButton icon="x" label="Close player" onPress={onClose} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  rec: { flexDirection: 'row', alignItems: 'center', gap: 2, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.control, paddingLeft: 10, height: 44 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 4 },
  dotWrap: { position: 'absolute', top: 12, right: 12 },
  dotPill: { flexDirection: 'row', alignItems: 'center', gap: 2, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.control, paddingHorizontal: 8, height: 26, opacity: 0.85 },
  bannerWrap: { position: 'absolute', top: 76, left: 0, right: 0, alignItems: 'center', paddingHorizontal: 16 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.panel, paddingLeft: 14, paddingRight: 8, paddingVertical: 8, maxWidth: '100%' },
  player: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center', borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.panel, paddingHorizontal: 6, height: 56, width: 640, maxWidth: '96%' },
  track: { flex: 1, height: 44, justifyContent: 'center', ...(Platform.OS === 'web' ? ({ cursor: 'pointer' } as object) : {}) },
  rail: { position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 2 },
  fill: { position: 'absolute', left: 0, height: 4, borderRadius: 2 },
  knob: { position: 'absolute', width: 14, height: 14, borderRadius: 7 },
  transcript: { alignSelf: 'flex-end', width: 340, maxWidth: '92%', maxHeight: 260, marginRight: 16, marginBottom: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.panel },
  line: { flexDirection: 'row', gap: 8, paddingVertical: 6, paddingHorizontal: 8, borderRadius: radius.inner, minHeight: 32 },
});
