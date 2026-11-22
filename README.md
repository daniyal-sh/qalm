<img src="assets/brand/qalm-mark.svg" width="72" alt="">

# Qalm by Apollo

Handwritten notes, on pages, that feel like paper and that AI agents can read live over MCP.

- `docs/decisions.md`: v1 scope
- `docs/tech-spec.md`: architecture and contracts between packages
- `docs/qink-live.md`: the AI-readable live format and MCP tools
- `docs/brand.md`: Qalm by Apollo design system
- `mockups/`: HTML mockups (layout reference)

```
packages/core      shared TypeScript: model, geometry, render, export, Q-ink
modules/qalm-ink   native ink surface + on-device recognition (iOS, Android, web)
apps/app           Expo app (iPad, Android, web)
apps/desktop       Electron (Windows, macOS)
apps/server        Cloudflare Worker (auth, sync, assets, MCP)
```
