# Q-ink Live: live notes for AI agents

Status: draft v0.2 (simplified) · Owner: qalm-core / mcp server

Goal: an agent anywhere can follow a live note-taking session accurately with few tokens.
Keep it simple. There's no server-side AI, no analyzers and no memory store.

## Decisions

- **Updates** go to the agent when the student pauses or taps **Ask**.
- **Every changed line goes out as a small image plus the on-device text guess.** That's accurate, and there are no thresholds to tune.
- **The agent can save its reading** of a line with `transcribe`. After that, the line is sent as text only.
- **The agent keeps its own chat history.** Each update is self-contained, so its client can trim old ones safely.

## 1. When updates are sent

- The pen has been idle for ≥ 6 s and something changed since the last update.
- Or the student taps **Ask**, which is sent immediately with the student's question attached.
- At most one update every 20 s (Ask is exempt).
- Changes in between are merged into one net diff. Ink that was written and then erased disappears.

## 2. Update format

Plain text lines, which cost fewer tokens than JSON.

```
#q s=calc2 r=431 p3 "Q3 ∫x^2 ln x dx"
 L3 v=x^3/3
+L4 [1] ~"=x3/3 lnx - ∫x3/3 1/x dx"
+L5 [2] ~"=x3/3lnx-x3/9"
-L6
ask "is L5 right?"
```

| Element | Meaning |
|---|---|
| `#q s= r= pN "title"` | header: session, revision, current page and its first line |
| ` L#` | one unchanged line above the first change, for context |
| `+L#` / `~L#` / `-L#` | added / changed / removed line |
| `[n]` | this line is row *n* of the attached image |
| `~"…"` | the on-device reader's guess (ML Kit on iPad and Android, Windows Ink on Windows, Apple Vision on Mac) |
| `"…"` without `~` | trusted text, already saved by `transcribe`. No image is sent |
| `ask "…"` | the student tapped Ask, with their question |

The **image** is a single strip of every line marked `[n]`, rendered from the strokes in black on white with row numbers.
There's one image per update.

**Line IDs** (`L4`) are stable for each page, so comments and `transcribe` can point at them.
Drawings that aren't lines are numbered `D1` and also go into the image strip.

## 3. MCP tools (4)

| Tool | Args | Does |
|---|---|---|
| `wait` | `s?` | waits for the next update (long-poll). With no `s`, it lists the live sessions the agent can see |
| `read` | `ref` | anything on demand: `p3`, `p3:L2-9`, `outline` or `pdf:p2`, as text plus an image strip where needed |
| `transcribe` | `ref`, `text` | saves the agent's reading of a line. The student can edit it |
| `comment` | `ref`, `text` | pins a comment next to a line. Never changes ink |

The student grants access for each notebook or folder on the approval screen. `transcribe` and `comment` each have their own switch.

## 4. Rough budget (one hour of math tutoring)

About 60 updates an hour, with every changed line as an image. Priced at GPT-6 Luna's standard rates:

| Design | Peak context | $/h uncached | $/h cached |
|---|---|---|---|
| Full-page screenshots | ~219k | $1.36 | $0.17 |
| **Q-ink Live v0.2** | ~38k | ~$0.13 | ~$0.025 |

These are estimates. The first thing to measure with a real client is how each provider counts image tokens.
