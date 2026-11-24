/**
 * AI sharing liveness ("Play / Pause AI" in the editor). Agents get data over MCP only while one of the owner's
 * devices is playing the notebook. It is ephemeral and server-verified, never a synced flag: text frames on the
 * notebook's sync socket (`nb:{id}`), and the notebook's room counts a socket as live until `AI_LIVE_TTL_MS` after
 * its last accepted frame, or until it closes.
 *
 * Client → server:
 * - `AI_PLAY` (the Play button): this socket is live. The room answers `ai:playing:<epoch>`.
 * - `AI_LIVE` every `AI_LIVE_EVERY_MS`: keeps an already-live socket live. On a socket that isn't live (it expired,
 *   or a Pause got there first) it is ignored and the room answers `AI_PAUSED`.
 * - `ai:resume:<epoch>` after a reconnect: live again only if no Pause happened since that epoch (on any device);
 *   otherwise the room answers `AI_PAUSED`. So a device that missed a Pause while offline can't bring sharing back.
 * - `AI_PAUSE` (the Pause button): stops every device; the epoch goes up and the other sockets get `AI_PAUSED`.
 * - `AI_STOP`: this device alone stops (backgrounded, notebook closing).
 */
export const AI_PLAY = 'ai:play';
export const AI_LIVE = 'ai:live';
export const AI_RESUME = 'ai:resume:';
export const AI_PAUSE = 'ai:pause';
export const AI_STOP = 'ai:stop';
/** Server → client: Play or a resume was accepted at this pause epoch (`ai:playing:<n>`). */
export const AI_PLAYING = 'ai:playing:';
/** Server → client: not live (someone pressed Pause, or this socket's heartbeat or resume was refused). */
export const AI_PAUSED = 'ai:paused';
export const AI_LIVE_EVERY_MS = 15_000;
/** Two missed heartbeats plus slack: a sleeping or vanished device stops sharing within this. */
export const AI_LIVE_TTL_MS = 40_000;
