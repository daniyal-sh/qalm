# Q-ink Live: live notes for AI agents

Status: draft v0.4 (comment threads, Ask about a selection, open threads on a first look) · Owner: qalm-core / mcp server

Goal: an agent anywhere can follow a live note-taking session accurately with few tokens.
Keep it simple. There's no server-side AI, no analyzers and no memory store.

## Decisions

- **Updates** go to the agent when the student pauses, taps **Ask** or writes a comment.
- **Every changed line goes out as a small image plus the on-device text guess.** That's accurate, and there are no thresholds to tune.
- **The agent can save its reading** of a line with `transcribe`. After that, the line is sent as text only.
- **The agent keeps its own chat history.** Each update is self-contained, so its client can trim old ones safely.
- **Comments are threads, both ways.** The student can reply to the agent, or start a thread on a line or a selection.
  The agent sees those in its updates and answers in the thread. The protocol has no modes (no "tutor mode"): agents
  receive updates and send comments, and the app makes that feel live.

## 1. When updates are sent

- The pen has been idle for ≥ 6 s and something changed since the last update.
- Or the student taps **Ask**, which is sent immediately with the student's question attached. An Ask can be about a
  selection (lasso).
- Or the student writes a comment or a reply, which is also sent immediately.
- At most one update every 20 s (Asks, comments and replies are exempt).
- Changes in between are merged into one net diff. Ink that was written and then erased disappears.

## 2. Update format

Plain text lines, which cost fewer tokens than JSON.

```
#q s=calc2 r=431 p3 "Q3 ∫x^2 ln x dx"
 L3 v=x^3/3
+L4 [1] ~"=x3/3 lnx - ∫x3/3 1/x dx"
+L5 [2] ~"=x3/3lnx-x3/9"
-L6
re C2 "which sign?"
note C7 p3:L5 "is this the same as the book?"
ask "is L5 right?"
```

| Element | Meaning |
|---|---|
| `#q s= r= pN "title"` | header: session, revision, current page and its first line |
| ` L#` | one unchanged line above the first change, for context |
| `+L#` / `~L#` / `-L#` | added / changed / removed line |
| `[n]` | this line is row *n* of the attached image |
| `~"…"` | the on-device reader's guess (ML Kit on iPad and Android; none from desktop in v1) |
| `"…"` without `~` | trusted text, already saved by `transcribe`. No image is sent (except for a selection, below) |
| `ask "…"` | the student tapped Ask, with their question |
| `ask C6 p3:L4-6 [n] "…"` | an Ask about a selection: its thread (`C6`: answer there), the lines it covers, and `[n]`, a crop of the selected region, only when the selection isn't whole lines (part of a line, a text box, a picture). With no ink lines selected the ref is just `p3` |
| `note C5 p3:L4 "…"` | the student started thread `C5` on L4 (`p3:L4-6` for a selection, `p3` when it covers no ink line) |
| `re C3 "…"` | the student replied in thread `C3` |
| `open C2 p3:L4 student "…"` | an unresolved thread the agent hasn't been sent before, on a page it is seeing for the first time, with only its latest message (`student` or `agent` says who wrote it). `read C2` gives the whole thread |

The **image** is a single strip of every line marked `[n]`, rendered from the strokes in black on white with row numbers.
There's one image per update.

**Ask about a selection.** The selected lines are always in the image, even unchanged or already-transcribed ones
(` L4 [2] "x=2"` is trusted text that also has a row). Example: the student lassoes lines 4–5 and a sketch beside them:

```
#q s=calc2 r=9 p3 "Q3 ∫x^2 ln x dx"
 L4 [1] ~"=x3/3 lnx"
 L5 [2] "x^3/3 ln x - x^3/9"
ask C6 p3:L4-5 [3] "why minus?"
```

**Line IDs** (`L4`) are short labels that the server assigns and stores (internally each line is keyed by its first stroke's ID). They're stable for each page, so comments and `transcribe` can point at them.
Drawings that aren't lines are numbered `D1` and also go into the image strip.

**Thread IDs** (`C1`, `C2`, …) are assigned by the server too, notebook-wide, and never reused. Only the student's words
are sent (each entry once per agent); the agent's own comments never come back to it. Comment text is cut at 1000
characters.

**A new agent gets no replay of history.** Asks from before it connected are not sent. The first time a page is in one
of its updates (it changed, or has an Ask), that page's threads are not replayed either: each **unresolved** thread goes
out once as `open C2 p3:L4 student "latest message"`, and resolved threads are skipped. After that the page works as
above (only new entries). Anything else is a `read` away: `p3` for the ink, `C2` for a whole thread.

**Malformed Asks.** Asks are written by clients, so the server checks each one. A bad selection or thread id is dropped
(the Ask goes out as a plain `ask`), an Ask with no page is skipped, and either is logged. One bad Ask never stops
updates.

A thread read lists every entry, oldest first:

```
#q C5 p3:L4
student "is this right?"
agent "Check the sign"
student "which sign?"
```

The header ends in ` resolved` for a resolved thread.

## 3. MCP tools (4)

| Tool | Args | Does |
|---|---|---|
| `wait` | `s?` | waits for the next update (long-poll). With no `s`, it lists the live sessions the agent can see |
| `read` | `ref` | anything on demand: `p3`, `p3:L2-9`, `outline`, `pdf:p2` or a thread `C5`, as text plus an image strip where needed |
| `transcribe` | `ref`, `text` | saves the agent's reading of a line. The student can edit it |
| `comment` | `ref` or `thread`, `text`, `resolve?` | with `ref` (`p3:L4`) starts a thread next to a line and says its label (`as thread C8`); with `thread` (`C3`) replies in it. `resolve` also marks the thread resolved: use it only when the thread is trivially done. Never changes ink |

The student grants access for each notebook or folder on the approval screen. `transcribe` and `comment` each have their own switch.
A student's reply reopens a resolved thread.

**Presence and pause (app side, no protocol change).** The app shows "Claude is following along" while an agent has a
pending `wait` on the notebook or made a call in the last minute, named by its OAuth client name. The student can
**pause sharing** there: while paused, `wait` sends nothing (it times out as `#q s=… paused`, and the session list marks
the session `paused`), and `read`, `transcribe` and `comment` fail with a message saying so. The grant stays. When the
student resumes, a pending `wait` wakes and the next update catches up on everything since the last one, so agents
should simply keep calling `wait`. "Stop" turns the notebook's AI access off.

## 4. Rough budget (one hour of math tutoring)

About 60 updates an hour, with every changed line as an image. Priced at GPT-6 Luna's standard rates:

| Design | Peak context | $/h uncached | $/h cached |
|---|---|---|---|
| Full-page screenshots | ~219k | $1.36 | $0.17 |
| **Q-ink Live v0.2** | ~38k | ~$0.13 | ~$0.025 |

These are estimates. The first thing to measure with a real client is how each provider counts image tokens. Threads add
only the student's words (a few tokens each); a selection Ask adds its rows to that update's image.
