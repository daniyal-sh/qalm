# Lecture mode

Status: v1 spec · Owner: core / server / app · Read with `tech-spec.md` (§2 model, §4 server) and `qink-live.md` (MCP).

An optional mode, mainly for teachers. It is **off by default**, turned on per device in **Settings → Lecture mode**, and
**account-only**: signed out, the switch is disabled ("Sign in to record lectures"). When it's on, the editor's top bar has
a **Record** button. A recording is a **session**: one audio timeline, every ink event on that timeline, the region crops an
agent would have received, and a timed transcript. A session can span many pages; a notebook can hold many sessions,
listed in the editor (**Lectures**) with date and length.

Keep it simple: lecture data never goes into page docs, ink stays the source of truth for the page, and the session
only *records* what happened. Agents still never change ink.

## 1. Recording

**States:** `recording` → `paused` ⇄ `recording` → `stopped`. One session records at a time per device.

- **Record** starts a session on the current notebook. Audio and the ink log start together at `t = 0`.
- **Pause** stops the audio **and locks the pen**: the overlay gets `tool: 'none'`, undo/redo and selection edits are
  disabled, and a banner says **"Recording paused · resume to write"**. Nothing can be written while paused, so the
  timeline never needs a wall-clock gap.
- **Resume** continues the same timeline (`t` carries on from where it paused).
- **Stop** ends the session. The last audio chunk is saved, the last timeline chunk flushed, and (with cloud
  transcription) the last chunk transcribed.

**The timeline clock** (`LectureClock`, core) counts only recording time: `t = elapsed + (now − resumedAt)` while
recording, frozen while paused. Every event and every audio chunk is stamped with it, in milliseconds.

**Audio:** speech quality, mono, ~32 kbps.

| Platform | Recorder | Format |
|---|---|---|
| Web, Electron | `MediaRecorder` on `getUserMedia({audio: {channelCount: 1}})` | `audio/webm;codecs=opus`, 32 kbps |
| iPad | `expo-audio` | AAC (`.m4a`), 32 kbps, mono, 22.05 kHz |
| Android | `expo-audio` | AAC (`.m4a`), 32 kbps, mono, 22.05 kHz |

Audio is recorded in **chunks of 2 minutes** (`AUDIO_CHUNK_MS`). Each chunk is a complete, standalone file (the
recorder is stopped and restarted), so a crash loses at most one chunk, each chunk can be transcribed on its own, and
nothing has to be re-muxed. A chunk records its start `t0` and length `dur` on the timeline; the few milliseconds between
chunks are silence on playback. Pause ends the current chunk; resume starts a new one.

**Background:** recording continues when the app is in the background.
- **Android:** `expo-audio` with `enableBackgroundRecording` (a `microphone` foreground service with the system
  notification "qalm is recording", `FOREGROUND_SERVICE_MICROPHONE`). The system mic indicator shows.
- **iPad:** `UIBackgroundModes: audio` and an active `AVAudioSession` (`playAndRecord`); the system shows the red
  recording indicator.
- **Web and desktop:** `MediaRecorder` keeps recording while the tab or window is minimised. Electron's window sets
  `backgroundThrottling: false` so chunk rotation and uploads keep their timers.

## 2. Timeline events

The **ink log** (`attachLectureLog`, core) watches the page docs the editor has open and logs every **local** change
(origin `LOCAL_ORIGIN` or this device's undo manager). Remote edits (other devices, agents) are not logged. Events are
JSON objects, one per line (JSONL), in time order:

```jsonc
{"t":0,"k":"start","at":1764000000000}                       // wall-clock start (ms since epoch)
{"t":0,"k":"page","p":"<pageId>","n":3}                      // the page shown (n = 1-based position then)
{"t":0,"k":"base","p":"<pageId>","ids":["s1","s2"]}           // ink already on the page when the session first saw it
{"t":5120,"k":"add","p":"<pageId>","items":[<item>]}          // strokes, shapes, text, images added (full points)
{"t":9800,"k":"erase","p":"<pageId>","items":[<item>]}        // removed items, with their full points
{"t":12000,"k":"update","p":"<pageId>","items":[<item>],"before":[<item>]}  // moved, transformed, recoloured: the items after;
                                                              // `before` only for items the log has not seen yet (base ink)
{"t":14000,"k":"add","p":"<pageId>","items":[<item>],"by":"undo"}  // an undo or redo (by: "undo" | "redo")
{"t":20000,"k":"pause"}
{"t":20000,"k":"resume"}
{"t":61000,"k":"stop"}
```

- **Items** are core `Item`s (tech-spec §2) with stroke points as arrays `[x, y, pressure, tilt, azimuth, tMs]`
  (x, y in PDF points rounded to 0.01; pressure, tilt and azimuth to 0.001; t whole ms since the stroke began). A
  stroke's start on the timeline is the event's `t` minus its last point's `t`.
- One Yjs transaction is one event per kind (a lasso move of 40 strokes is one `update`).
- **Replay** (`LectureReplay`, core): the state at `t` is the page's `base` ink (read from the page doc, or from the
  first `before`/`erase` that carries it) with every event up to `t` applied. Erased strokes come back before their
  erase time. `strokeTimes()` maps each stroke id to the `t` it was written (tap-to-seek).

## 3. Region crops

At each **writing pause**, the session stores exactly the crops an MCP agent following the notebook would get: the
same engine (`encodeQinkUpdate`), the same notebook-wide region registry (real `R` labels an agent can `read`,
`comment` on or `transcribe`), and the same boxes on the 0–1000 grid.

- They are made **on the server**, by the notebook's DocRoom, which follows a recording session as a virtual agent
  (`lecture:{sessionId}`) with the agent wake rules: pen idle ≥ 6 s, something changed, ≥ 20 s since the last crop. A
  pause or stop flushes at once. The first crop of a page shows only what the session wrote there: the page's ink at
  the session start (its `base` event, with base ink the session later moved or erased taken as it was) counts as
  already seen. A page the session has no `base` for is a first look.
- Crops cover only ink written **since the session started** (`startedAt`, or the time the server first heard of it if
  that is earlier). A session that arrives already `stopped` (an import, or one recorded offline and finished) gets no
  crops. A stopped session gets one last crop as it stops, never later ones.
- A crop's region labels, ink-seen state and the crop itself (as pending) are saved together, with no await in
  between; rendering the PNG, storing it and adding it to the session doc come after. If that fails, only the storage
  is retried, so a failure never loses the crop.
- A crop that fails **backs off** (15 s, 30 s, 1, 2, 4, 8, then 10 min; about 26 minutes in all) instead of retrying
  on every pen-up; after 8 failures those changes are skipped (the timeline still has every stroke). A session stopped
  during a back-off keeps its last crop: the retry makes it.
- A live session that reports nothing for 15 minutes while recording (no stroke, no 2-minute audio chunk), or 6 hours
  while paused, is **expired**: a crashed app or a closed tab. It reads as `stopped` to agents and takes no more crops;
  if the device comes back and reports again, it is live again. On start, the app stops any session it left live.
- Each crop is saved as a PNG (rendered with resvg, as for agents) in R2 as a content-addressed asset of the notebook's
  owner (counted in `user_assets`), and listed in the session doc: `{t, sha, w, h, text, regions}` where `text` is the
  Q-ink update text and `regions` is `[{label, page, box: [x, y, w, h] on the grid, add, erase}]`.
- `t` is the time of the last ink event the server had when the pause began (the client flushes the timeline about a
  second after each stroke, so it's the last stroke before the pause).
- **Offline:** crops need the server. While a device records offline the ink still syncs later, and the server makes one
  crop of everything written when it arrives (stamped with the last event's `t`). The timeline itself is complete.

## 4. Transcription

Transcript segments are saved in the session: `{t0, t1, text, words?: [{w, t0, t1}], src: "device" | "cloud"}` on the
timeline (ms).

- **Default, on-device** (`modules/qalm-lecture`): each finished audio chunk is transcribed on the device, then its
  segments are shifted by the chunk's `t0`.
  - **iPad:** `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true` on the chunk file (SpeechAnalyzer where
    available, iOS 26+); word timings from `bestTranscription.segments`, grouped into lines at gaps ≥ 0.8 s.
  - **Mac (desktop):** the same recognizer in a tiny Swift helper (`apps/desktop/native/mac-transcribe`) that Electron
    runs on each chunk; it is bundled only when built on a Mac.
  - **Android:** `SpeechRecognizer.createOnDeviceSpeechRecognizer` (Android 13+, where
    `isOnDeviceRecognitionAvailable` and the language is installed), fed the chunk decoded to 16 kHz PCM through
    `EXTRA_AUDIO_SOURCE`; word timings (`EXTRA_REQUEST_WORD_TIMING`) on Android 14+, otherwise segment times spread
    over the chunk.
  - **Windows and web:** there is no on-device recognizer. Settings says so and offers to switch to cloud; sessions
    record without a transcript until then.
- **Settings → "Cloud transcription (Whisper)"** (off by default): each finished chunk (every 2 minutes and at stop) is
  sent to `POST /lectures/transcribe`, which runs Whisper on Workers AI (`@cf/openai/whisper-large-v3-turbo`) and
  returns segments with word timings. A chunk that can't be sent (offline) is queued and retried.

**Server endpoint** `POST /lectures/transcribe?lang=xx` (Bearer, live user), body = one audio chunk (`audio/webm`,
`audio/ogg`, `audio/mp4`, `audio/mpeg` or `audio/wav`, ≤ 8 MB) → `{segments, durationMs, usedMinutes, limitMinutes}`.
- Rate limit: `TRANSCRIBE_PER_MINUTE` requests per user per minute (default 6) → 429 with `Retry-After`.
- Monthly cap: `TRANSCRIBE_MINUTES_PER_MONTH` per user (default 600) → 402 `{code: 'transcribe_quota'}`. A request
  is charged the audio length Whisper reports, in full (a 30-minute chunk is 30 minutes), in D1 `transcribe_usage`.
- **Concurrency:** each request first reserves an upper bound (its bytes at a 6 kbps floor, or the client's claim if
  larger), clamped to what is left of the month, then counts only the rows before it (by id). Parallel requests are
  ordered: at most N pass the per-minute limit, and once the reservations fill the month the rest get 402, so the cap
  is passed by at most the one request that took what was left. A rejected request takes its reservation back; a
  failed Whisper run stays as a 0 ms row, which charges nothing but still counts per minute.
- The 8 MB limit holds while the body streams in, with or without a `Content-Length`.
- Binding `AI` (Workers AI) in `wrangler.jsonc` for local, staging and production. No binding → 503.

## 5. Storage and sync

```
lec:{notebookId}:{sessionId}   session doc (one DocRoom each, synced like any doc, counted in doc_sizes)
  meta:       Y.Map  { id, notebookId, startedAt, durationMs, state, lastT, transcriber: 'device'|'cloud'|'none', title? }
  timeline:   Y.Array<Uint8Array>   deflated JSONL chunks, append-only (flushed ~1 s after a stroke, at pause/stop, ≤ 10 s)
  audio:      Y.Array<{ sha, mime, t0, dur, bytes }>   R2 assets (content-addressed, user_assets)
  transcript: Y.Array<Segment>
  crops:      Y.Array<{ t, sha, w, h, text, regions }> written by the server; PNGs are R2 assets

lib:{userId}
  lectures:   Y.Map<sessionId, { id, notebookId, startedAt, durationMs, state, title? }>   the list the app shows
```

- **Out of the page docs:** a regular notebook doesn't grow. Page and index docs are unchanged.
- **Cap:** the session doc counts in `doc_sizes` (owner = the notebook's owner), audio and crops in `user_assets`, so
  `GET /me/storage` covers all of it. Like ink, recording is never refused when full; an audio upload that doesn't fit
  stays queued (413) and the app shows the storage-full message.
- **Delete a session** (Lectures → Delete): `DELETE /lectures/{notebookId}/{sessionId}` first **tombstones** it (D1
  `deleted_lectures`: no sync ticket for it again, 410, so another device's copy or a queued transcript can't bring it
  back), then purges the session room and its `doc_sizes` row and frees its assets. Assets are content-addressed and
  can be shared (an export imported again, identical crops): each session room records the shas it references in D1
  `lecture_assets`, and a sha leaves `user_assets` only when no other session of the user references it (the R2 object
  goes when no other user holds it either). A page asset (PDF, image) of any of the user's notebooks with the same
  bytes keeps it too. Lecture audio uploads name their session (`X-Qalm-Lecture: lec:{nb}:{sid}`): the reference is
  recorded at once, and an upload that lands after the delete gets 410 and is not stored. The app removes the
  library entry, its local copies, its queued uploads and any queued transcription for it.
- `GET /lectures/{notebookId}/{sessionId}` → `{deleted}`: a device asks before it touches a session again (e.g. stopping
  one its crash left live), so a session deleted elsewhere stays deleted.
- **Delete forever** of a notebook deletes each of its sessions the same way (their audio and crops stop counting
  against the cap). **Account deletion** purges every room in `doc_sizes` (which includes `lec:` rooms), every asset,
  and the `transcribe_usage`, `lecture_assets` and `deleted_lectures` rows. On the device, deleting the account or a
  notebook forever removes the local `lec:` docs too.

Measured sizes per hour are in §9.

## 6. Playback

The **player bar** (bottom of the editor while a finished session is open): play/pause, a scrubber with the time,
speed 1× / 1.5× / 2×, and close.
- While it's open, the pages draw the **replayed** ink at the current time instead of the live page: strokes appear as
  they were written, erased strokes come back and vanish at their erase time, moves happen when they happened. The
  pen is locked (`tool: 'none'`) while replaying.
- **Tap a stroke** to jump the audio to when it was written.
- The **transcript panel** follows along (the current line highlighted, auto-scrolled); tapping a line seeks to it.
- Audio plays chunk by chunk (`audio` list), switching at chunk ends; a missing chunk plays as silence.

## 7. AI over MCP

Still four tools (`wait`, `read`, `transcribe`, `comment`); lecture data is read-only.

- **Labels:** sessions get notebook-wide labels `L1`, `L2`, … (assigned by the notebook room, never reused).
- **Live:** while a session records, `wait` updates also carry its **new transcript lines** with their times, after the
  region lines: `L2 03:12 "so the derivative of x squared"`. Transcript lines alone also wake a `wait` (with the
  20 s rate limit, not the pen-idle rule). A new agent starts from the current line (no replay). At most 30 lines per
  session go in one update: a longer catch-up ends with `more: read("L2@03:12")` from the earliest line left out. A
  session that only ever arrived stopped (an import) sends no live lines; `read("L2")` has its transcript.
- `wait()` with no session lists `lecture L2 recording 12:40` on a playing notebook's line
  (`s=… "Calculus" live lecture L2 recording 12:40`); a paused notebook's line is only `s=… paused`, with no title and
  no lecture.
- **After:** `read("outline")` lists the notebook's sessions (`L2 2026-11-24 47:10 stopped`). `read("L2")` returns
  the transcript and crops **interleaved by time**: text lines `03:12 "…"` and crop lines `03:15 R40 p2 @120,300
  260x80 +5`, with the crops' images as image blocks in the same order. One read covers 10 minutes and at most 8
  images; it ends with `more: read("L2@10:00")` (exact to the ms when a window stops at a crop, e.g.
  `L2@03:15.250`, so a page of crops never repeats). Only images the notebook's owner holds are sent.
- **Only while playing:** every lecture output to an agent (live lines, the session list's `lecture L2 …`, outline
  lines, `read("L2")`) goes through one check, `AgentHub.lectureLive()` in `apps/server/src/agent.ts`, at the moment it
  goes out (and again after each await). It is the Play / Pause AI gate itself, `isLive()` (AI access on, a device
  playing, the old `aiPaused` not set); reads that must fail use `requireLive()`. Lecture mode makes no agent writes
  (crops are the server's own records in the session doc), so nothing goes through `applyAgentEdit`. **Decided:** lines spoken while not live are not dropped: like ink written meanwhile, they
  go out with the next update once the notebook is live again (capped as above), because while playing an agent can
  read the whole notebook and lecture anyway.

## 8. Export

The export menu's **Export .qalm backup** asks first when the notebook has sessions: **"Include lecture recordings"**
(off by default).
- **Off:** today's `.qalm`, byte-for-byte the same code path. Nothing from sessions is in it (the index and page docs
  hold none).
- **On:** the same files plus, per session, `lecture/{sessionId}/`:
  - `LECTURE.md`: a short, plain explanation of the format (for any agent, without qalm's code);
  - `session.json`: `{id, startedAt, durationMs, pages: [{id, n}]}`;
  - `timeline.jsonl`: every event (§2), erased strokes' points included;
  - `audio/{n}-{t0}.{webm|m4a}`: the chunks, in order;
  - `crops/{n}-{t}.png` and `crops/{n}-{t}.json` (`{t, text, regions}`);
  - `transcript.json`: `[{t0, t1, text, words?}]`.
- **Import** restores the sessions into the new notebook (new session ids, page ids remapped, audio and crops added as
  assets) when signed in; signed out (or an older app) they are skipped safely: unknown zip entries are ignored.

## 9. Sizes (measured)

See the table in the final report and `packages/core/test/lecture.size.test.ts`: per hour of lecture, audio is
~14.4 MB (32 kbps), the timeline ~1–3 MB deflated for 2,000–4,000 strokes, crops ~5–10 MB (one PNG per pause), the
transcript ~0.1 MB. About 20–30 MB per hour: the 250 MB cap holds roughly 8–12 hours.

## 10. Not in v1

Editing a recording, sharing it, video, live streaming to students, speaker labels, and translation.
