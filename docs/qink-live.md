# Q-ink Live: live notes for AI agents

Status: v1.0 (regions replace lines; no on-device recognition) · Owner: qalm-core / mcp server

Goal: an agent anywhere can follow a live note-taking session accurately with few tokens.
Keep it simple. There's no server-side AI, no analyzers, no recognizer and no memory store.

## Decisions

- **Updates** go to the agent when the student pauses, taps **Ask** or writes a comment.
- **The agent reads the handwriting itself.** What changed goes out as **regions**: crops of the strokes added or erased
  since the agent's last update, with the ink around them for context. There is no line grouping and no on-device
  guess (v0.4 split maths apart: a superscript ² became its own line, a tall ∫ a separate drawing, two expressions on one
  ruled line two lines, and the agent "corrected" correct work).
- **The agent can save its reading** of a region with `transcribe`. While those strokes are unchanged, they are sent as
  text instead of an image. If the student adds to them or erases from them, the reading is marked **stale**.
- **The agent keeps its own chat history.** Each update is self-contained, so its client can trim old ones safely.
- **Comments are threads, both ways**, attached to the strokes they are about (they follow the ink). The protocol has no
  modes (no "tutor mode"): agents receive updates and send comments, and the app makes that feel live.

## 1. When updates are sent

- The pen has been idle for ≥ 6 s and something changed since the last update.
- Or the student taps **Ask**, which is sent immediately with the student's question attached. An Ask can be about a
  selection (lasso).
- Or the student writes a comment or a reply, which is also sent immediately.
- At most one update every 20 s (Asks, comments and replies are exempt).
- Changes in between are merged into one net diff. Ink that was written and then erased never appears.

## 2. Update format

Plain text lines, which cost fewer tokens than JSON, plus at most **one image** whose rows are numbered `[n]`.

The owner's page: `∫ 2x cos(x²) dx` is on the page; the student writes `u = x²   du = 2x dx` beside it and pauses.

```
#q s=calc2 r=12 p1 1000x1415
R2 [1] p1 @99,154 596x68 +20 (was R1)
```

![The update's image: one row, the new u-substitution in black, the integral in grey](https://github.com/daniyal-sh/qalm/blob/pr-assets/regions/regions-after-2.png?raw=true)

One region: the 20 new strokes in black, and the whole integral (∫, the superscript ², `dx`) in grey as context,
because the new writing is on the same row right next to it. `(was R1)` says R2 replaces region R1, which the agent
was sent before (here, the first look at the page).

| Element | Meaning |
|---|---|
| `#q s= r= pN WxH` | header: session, revision, the current page and its size on the grid (A4 portrait is `1000x1415`). `first look` follows when the agent is seeing that page for the first time |
| `pN WxH` | another page with changes in this update (`first look` likewise) |
| `R7 [1] p6 @120,300 260x80 +5 -1` | region `R7`: row 1 of the image, on page 6, its box at x,y with width x height on the grid, with 5 strokes added (or moved there) and 1 erased |
| `(was R3,R4)` | R7 overlaps regions this agent was sent before; it replaces them |
| `R7 p6 @120,300 260x80 "u = x^2"` | a region whose strokes are all read by fresh readings: their text instead of an image row (first looks and page reads only; a changed region is always an image) |
| `ask "…"` | the student tapped Ask, with their question |
| `ask C6 R9 [3] p6 @… "…"` | an Ask about a selection: its thread (`C6`: answer there) and region `R9` (the selection in black, the ink around it in grey), always as an image row. A selection with nothing left on the page is a crop of its box: `ask C6 p6@120,300,260,80 [3] "…"` |
| `note C5 p6@120,300,260,80 "…"` | the student started thread `C5` on the strokes in that box (`p6` when it is on the whole page or its ink was erased) |
| `re C3 "…"` | the student replied in thread `C3` |
| `open C2 p6@… student "…"` | an unresolved thread the agent hasn't been sent before, on a page it is seeing for the first time, with only its latest message (`student` or `agent` says who wrote it). `read C2` gives the whole thread |

**The image.** White background, each row labelled `[n]` on the left. In a row, **new strokes are solid black**, the
**context is mid-grey** and **erased strokes are faint red and dashed**. Rows may come from several pages. Every new
stroke is in some row, whole: rows are never clipped and new ink is never capped, however large.

**Coordinates.** A grid of 0–1000 across the page width, with y in the same units, so A4 portrait is 1000×1415 and A4
landscape 1000×707. Boxes are rounded outwards, so a box always holds all of its ink.

### Regions

All lengths are in **units**: the typical height of handwriting on the page. On ruled and Cornell paper it is the rule
spacing (24 pt); on grid and dotted paper the grid spacing (18 pt); otherwise 2.5 × the median stroke height (dots and
tall strokes like ∫ don't move a median), clamped to 12–48 pt.

1. **Changes.** The strokes added or moved since the agent's last update, and the ones erased, compared with what it was
   last sent (the server keeps, per agent and page, each stroke's simplified path). Recolouring isn't a change.
2. **Clusters.** Changed strokes closer than **2 units** (box to box) are one cluster, transitively.
3. **Context.** Each cluster pulls in the existing strokes that overlap it or are within **½ unit** of a changed
   stroke, then grows along the row: any stroke with a horizontal gap under **1½ units** and a vertical overlap of at
   least 30% of the smaller height joins, transitively, so writing next to or over an old equation brings the whole
   equation. Growth only passes through strokes whose centre is within ½ unit of the changed strokes' rows, and stops at
   600 strokes, so it can't swallow the page.
4. **Overlaps.** Clusters whose boxes overlap once context is added are merged, so regions never overlap. Far-apart
   clusters stay separate regions (separate rows).
5. **Scale.** A row is drawn at 64 px per unit (48 px on a first look, 72 px for `read`), shrunk for very big regions
   to about 480,000 px per row (never below 24 px per unit) and to at most 1600 px wide.

**Region labels** (`R1`, `R2`, …) are notebook-wide and never reused. The server assigns and stores them (in the
notebook's room), each with its page, strokes and box, so `transcribe`, `comment` and `read` can refer to them. A
region with exactly the same strokes as one of the agent's current regions keeps that label; otherwise it gets the next
label and lists the agent's current regions it overlaps as `(was …)`. The server keeps the latest 600 regions; an older
label answers "too old, read the page".

**First look.** The first time a page is in one of an agent's updates (it changed, or has an Ask), all of its ink is
clustered into regions (same 2-unit rule, no context), each with coordinates, and read regions go as text:

```
#q s=calc2 r=1 p1 1000x1415 first look
R1 [1] p1 @99,97 253x193
```

**Erasing.** The student erases the `2x` of `du = 2x dx` and writes `x = 3` further down:

```
#q s=calc2 r=14 p1 1000x1415
R3 [1] p1 @99,154 596x68 -3 (was R2)
R4 [2] p1 @504,853 78x15 +5
```

![Row 1: the erased 2x faint red and dashed, the rest grey; row 2: x = 3 in black](https://github.com/daniyal-sh/qalm/blob/pr-assets/regions/regions-after-3.png?raw=true)

**Ask about a selection.** Then the student lassoes the `x` inside `cos(x²)` and asks. The selection is black, the
rest of its row (the integral and `u = x²`) grey:

```
#q s=calc2 r=15 p1 1000x1415
ask C1 R5 [1] p1 @99,154 495x68 "is this right?"
```

**Thread IDs** (`C1`, `C2`, …) are assigned by the server too, notebook-wide, and never reused. Only the student's words
are sent (each entry once per agent); the agent's own comments never come back to it. Comment text is cut at 1000
characters. Comments are Markdown: the app renders bold, lists, code, links and TeX maths (`$x^2$`, `$$…$$`) and strips
raw HTML; agents send and receive the text exactly as written.

**A new agent gets no replay of history.** Asks from before it connected are not sent. On a page's first look, the
page's threads are not replayed either: each **unresolved** thread goes out once as `open C2 p3@… student "latest
message"`, and resolved threads are skipped. After that the page works as above (only new entries). Anything else is a
`read` away: `p3` for the ink, `C2` for a whole thread.

**Malformed Asks.** Asks are written by clients, so the server checks each one. A bad selection or thread id is dropped
(the Ask goes out as a plain `ask`), an Ask with no page is skipped, and either is logged. One bad Ask never stops
updates.

A thread read lists every entry, oldest first:

```
#q C5 p3@120,300,260,80
student "is this right?"
agent "Check the sign"
student "which sign?"
```

The header ends in ` resolved` for a resolved thread.

## 3. Readings

A **reading** is someone's text for some strokes: `{ strokes, text, source: agent | student, agent name, stale,
updatedAt }`, stored per page.

- `transcribe(R7, "u = x^2")` saves the agent's reading of R7's strokes (those still on the page), replacing earlier
  agent readings of a subset of them. It is **refused** where the student's own reading covers any of them.
- When strokes are **added to** a read region (new or moved ink within ½ unit of it, or on its row within 1½ units: the
  same test that makes ink context) or **erased from** it, its
  reading is marked **stale**: kept and shown as stale in the app, but not trusted, so the region goes out as an image
  again. Moving, resizing or recolouring the read ink itself keeps it fresh. A reading whose strokes are all erased is
  deleted.
- In the app, the student selects ink and opens **Reading**: the readings of the selection (the agent's text with its
  name, or theirs; a "stale" badge). Editing makes the reading the student's own; agents can't overwrite it.

## 4. MCP tools (4)

Refs: a region `R7`, a box `p6@120,300,260,80` (x,y,w,h on the grid), a page `p6`, a thread `C5`, `outline`, `pdf:p2`.

| Tool | Args | Does |
|---|---|---|
| `wait` | `s?` | waits for the next update (long-poll). With no `s`, it lists the live sessions the agent can see |
| `read` | `ref` | anything on demand: `outline`; a page `p3` (all its ink as regions, read ones as text); a region `R7` (its strokes now, plus any readings of them, marked `stale` if so); a box (a crop of everything in it); `pdf:p2`; a thread `C5` |
| `transcribe` | `ref`, `text` | saves the agent's reading of a region or a box's ink (strokes whose centre is inside). The student can edit it |
| `comment` | `ref` or `thread`, `text`, `resolve?` | with `ref` (a region, box or page) starts a thread on those strokes, with the box as a fallback position, and says its label (`as thread C8`); with `thread` (`C3`) replies in it. `resolve` also marks the thread resolved: use it only when the thread is trivially done. Never changes ink |

**Which notebooks an agent sees.** An approved agent can use every notebook whose **AI access** is on, now and in the
future, and none other: there is no per-agent notebook choice. `wait()` lists exactly those, and every tool checks the
notebook's switch live (in its room) and that the grant is still valid, so turning AI access off hides a notebook from
every agent at once. The approval screen says so ("It can read the notebooks you've turned AI access on for") and keeps
the `transcribe` and `comment` switches, which also stay in Settings → AI access per agent.
A student's reply reopens a resolved thread.

**Presence and pause (app side, no protocol change).** The app shows "Claude is following along" while an agent has a
pending `wait` on the notebook or made a call in the last minute, named by its OAuth client name. The student can
**pause sharing** there: while paused, `wait` sends nothing (it times out as `#q s=… paused`, and the session list marks
the session `paused`), and `read`, `transcribe` and `comment` fail with a message saying so. The grant stays. When the
student resumes, a pending `wait` wakes and the next update catches up on everything since the last one, so agents
should simply keep calling `wait`. "Stop" turns the notebook's AI access off.

## 5. Rough budget (one hour of math tutoring)

About 60 updates an hour, priced at GPT-6 Luna's standard rates. Image tokens are estimated as width × height / 750.

| Design | Peak context | $/h uncached | $/h cached |
|---|---|---|---|
| Full-page screenshots | ~219k | $1.36 | $0.17 |
| Q-ink Live v0.2–0.4 (line strips + guess) | ~38k | ~$0.13 | ~$0.025 |
| **Q-ink Live v1.0 (regions)** | ~38k | ~$0.13 | ~$0.025 |

Measured on the owner's page (A4, ruled):

| | v0.4 (lines) | v1.0 (regions) |
|---|---|---|
| First look at the page (3 rows) | 507×396 px, ~268 tokens, 5 rows (`∫` and `²` split off) | 361×244 px, ~117 tokens, 1 row |
| `u = x²   du = 2x dx` written beside the integral | 757×178 px, ~180 tokens, 3 rows (`²` on its own row, `u = x` without its `²`, `du = 2x dx` a separate line) | 1005×123 px, ~165 tokens, 1 row with the integral as context |
| A full page of maths (28 rows), first look | 56 rows (each row split in two), 1011×3612 px, ~4,870 tokens | 458×1223 px, ~750 tokens (downscaled; `read(p1)` or a box for detail) |

Text lines are a little longer than v0.4's (a region line is ~12 tokens) but there are fewer of them and no guesses.
These are estimates. The first thing to measure with a real client is how each provider counts image tokens. Threads add
only the student's words (a few tokens each); a selection Ask adds one row to that update's image.
