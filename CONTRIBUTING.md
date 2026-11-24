# Contributing to qalm

Thanks for helping. Bug fixes, tests, docs and small improvements are welcome as pull requests.

**For anything big** (a new feature, a new dependency, a change to the sync format, the MCP protocol or the UI's
structure), **open an issue first** so we can agree on the approach before you spend time on it. qalm stays small on
purpose; see [docs/decisions.md](docs/decisions.md) for what's in and out of scope.

## Setup

You need Node 24 and pnpm (pinned in `package.json`'s `packageManager`; `corepack enable` installs it).

```bash
pnpm install
pnpm typecheck && pnpm test
```

How to run the server, the web app and the desktop app is in the [README](README.md#quick-start). The architecture is
in [docs/tech-spec.md](docs/tech-spec.md), and the development guide is [docs/development.md](docs/development.md).

## Checks a pull request must pass

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on every pull request:

- `pnpm typecheck` across all packages;
- the unit tests of `@qalm/core`, `@qalm/app`, `@qalm/server`, `@qalm/site` and `@qalm/desktop`.

Run them locally before you push. Add or update tests for what you change: pure logic lives in `*.logic.ts` files or in
`packages/core` precisely so it can be tested.

**CI can't build Android or iOS**, or run the Electron end-to-end test. If you change native code
(`modules/qalm-ink/ios`, `modules/qalm-ink/android`) or the desktop shell, say in the PR how you built and tested it,
on which device, and with which pen. For UI changes, add screenshots in light and dark.

## Code style

Follow the code around you:

- TypeScript in strict mode, ES modules, 2-space indent, single quotes, semicolons, lines up to about 120 characters.
- Small, plain functions; pure logic separated from React and platform code.
- Comments say *why*, briefly, in full sentences.
- Keep the Swift and Kotlin ink ports in step with `packages/core` (the stroke geometry has a parity test).
- UI follows [docs/brand.md](docs/brand.md): its tokens, Figtree and Geist Mono, no gradients or blur.
- **"qalm" is always lowercase**, in UI, docs and messages.
- Never commit secrets: they go in env vars or `apps/server/.dev.vars`, which is gitignored.

Keep commits focused, with messages that say what changed and why.

## Brand

The code is MIT, but the names "qalm" and "Apollo" and the logos aren't licensed. If you ship a fork, rebrand it. See
[TRADEMARKS.md](TRADEMARKS.md).

## Security

Don't open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
