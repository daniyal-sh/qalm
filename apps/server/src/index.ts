import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import type { Env } from './env';
import { appHandler } from './http';
import { mcpHandler } from './mcp';
import { GRANT_TTL_MS } from './grants';
import { origin } from './util';

export { DocRoom } from './room';

const providers = new Map<string, OAuthProvider<Env>>();

/** One provider per public origin (the protected resource URL must be absolute). */
function provider(base: string): OAuthProvider<Env> {
  let p = providers.get(base);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcpHandler as unknown as ExportedHandler<Env> & { fetch: NonNullable<ExportedHandler<Env>['fetch']> },
      defaultHandler: appHandler as unknown as ExportedHandler<Env>,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      accessTokenTTL: 3600,
      refreshTokenTTL: GRANT_TTL_MS / 1000,
      resourceMetadata: { resource: `${base}/mcp`, resource_name: 'qalm notebooks' },
    });
    providers.set(base, p);
  }
  return p;
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return provider(origin(req, env.PUBLIC_URL)).fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
