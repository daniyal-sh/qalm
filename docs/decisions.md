# qalm v1 decisions

Keep it simple. Anything not listed here is out of v1.

## Product
- Handwritten notes for general note-takers, in a GoodNotes-style page layout. Infinite canvas comes later.
- v1 tools: pen, highlighter, eraser, lasso select and move, typed text boxes, shape snapping, PDF import and annotation, images.
- Not in v1: handwriting search, sharing with other people, audio, stickers, templates marketplace.
- Export: PDF (ink flattened) and `.qalm` (full-fidelity backup).
- Handwriting recognition: English only at launch.

## Platforms
- iPad, Android tablets, Windows and macOS, all at launch. Linux and stylus phones are not a priority.
- Minimum OS: iPadOS 17, Android 10, Windows 10, macOS 13.
- Pen extras: hover preview, pen button/squeeze/double-tap to eraser, tilt shading.
- Shell: React Native (iPad, Android) and Electron (Windows, macOS). Only the stroke in progress is native. All finished content is drawn by one Skia renderer everywhere.

## Accounts and backend
- Sign in with Apple, Google or an email magic link.
- Free while in beta, with capped storage. No payments in v1.
- Cloudflare: Workers + Durable Objects (sync, MCP), R2 (files), plus a database for accounts.
- Notebooks are encrypted at rest. No end-to-end encryption.

## AI (MCP only)
- See `qink-live.md`.
- Agents can read and comment, and can save a line's reading with `transcribe`. They can never edit ink.
- Updates go out on a pause (≥ 6 s) or when the student taps Ask, at most one every 20 s.
- Every changed line is sent as an image plus the on-device guess. There's no server-side model.
- The agent keeps its own chat history, and updates are self-contained.
- No on-device recognition (ML Kit was removed). Handwriting is read by the agent's vision from the page image, the same on every
  platform, and the app is about 20 MB lighter per language.
