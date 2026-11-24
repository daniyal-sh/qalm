/**
 * AI sharing liveness ("Play / Pause AI" in the editor). Agents get data over MCP only while one of the owner's
 * devices is playing the notebook. It is ephemeral and server-verified, never a synced flag: while playing, the
 * editor sends `AI_LIVE` as a text frame on the notebook's sync socket (`nb:{id}`) every `AI_LIVE_EVERY_MS`, and the
 * notebook's room counts it as live until `AI_LIVE_TTL_MS` after the last one, or until that socket closes.
 * `AI_PAUSE` stops sharing on every device at once; the room tells the other sockets with `AI_PAUSED`.
 */
export const AI_LIVE = 'ai:live';
export const AI_PAUSE = 'ai:pause';
/** Server → the notebook's other sockets: someone pressed Pause. */
export const AI_PAUSED = 'ai:paused';
export const AI_LIVE_EVERY_MS = 15_000;
/** Two missed heartbeats plus slack: a sleeping or vanished device stops sharing within this. */
export const AI_LIVE_TTL_MS = 40_000;
