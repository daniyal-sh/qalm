import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { DocRoom } from './room';

export interface Env {
  DB: D1Database;
  ASSETS: R2Bucket;
  DOC_ROOM: DurableObjectNamespace<DocRoom>;
  /** Storage for @cloudflare/workers-oauth-provider (clients, grants, token hashes). */
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider into the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;

  /** HS256 key for app access tokens and the web session cookie. Secret. */
  JWT_SECRET: string;
  /** Public origin, e.g. https://api.qalm.app. Defaults to the request's origin. */
  PUBLIC_URL?: string;
  /**
   * Where app sign-in links in emails point: the app's verify route, which POSTs the token back (a GET never uses a link up).
   * Normally the web app's `/auth/email/verify` (also the universal link on iOS/Android). Defaults to `qalm://auth/email/verify`.
   */
  MAGIC_LINK_URL?: string;
  /** 'console' (default: log the link) or 'resend'. */
  EMAIL_PROVIDER?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** Comma-separated audiences (bundle ids / service ids) accepted in Apple identity tokens. */
  APPLE_AUDIENCES?: string;
  /** Comma-separated OAuth client ids accepted in Google identity tokens. */
  GOOGLE_AUDIENCES?: string;
  /** Max asset upload size in bytes. Default 50 MB. */
  MAX_ASSET_BYTES?: string;
  /** Per-user storage cap for assets in bytes (free beta). Default 1 GiB. */
  MAX_USER_STORAGE_BYTES?: string;
  /** Wake rules (ms). Defaults 6000 / 20000; long-poll limit 45000. Tests shorten them. */
  WAKE_IDLE_MS?: string;
  WAKE_MIN_INTERVAL_MS?: string;
  WAIT_TIMEOUT_MS?: string;
}

/** What completeAuthorization() stores; reaches the MCP handler as ctx.props. */
export interface McpProps {
  userId: string;
  grantId: string;
  clientId: string;
  clientName: string;
}

export const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
