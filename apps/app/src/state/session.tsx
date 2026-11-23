/**
 * App-wide services: auth tokens, the doc manager (local persistence + sync), assets and the user's
 * library doc. Signed out (or with no server configured) everything works locally under `lib:local`.
 */
import { Library, type Folder, type LibraryEntry } from '@qalm/core';
import * as React from 'react';

import { AssetService } from '../assets/assetService';
import { decodeJwt, TokenManager, type Tokens, type User } from '../auth/tokens';
import { tokenStore } from '../auth/tokenStore';
import { config } from '../config';
import { kvGet, kvSet } from '../lib/kv';
import { DocManager, docIds, openLoaded, type DocHandle, type RemoteFactory } from '../sync/docs';
import { openPersistence } from '../sync/persistence';
import { SyncProvider, type SyncStatus } from '../sync/provider';
import { fetchTicket } from '../sync/ticket';
import { localToMove, moveLocalLibrary } from './localLibrary';

export const LOCAL_LIBRARY = 'lib:local';

export interface Profile {
  email?: string;
  provider?: 'apple' | 'google' | 'email';
  name?: string;
}

export interface Session {
  serverUrl?: string;
  tm: TokenManager | null;
  user: User | null;
  profile: Profile | null;
  /** Auth state has been read from storage. */
  ready: boolean;
  /** The user chose to use the app without an account. */
  skipped: boolean;
  setSkipped(v: boolean): void;
  dm: DocManager;
  assets: AssetService;
  library: Library | null;
  /**
   * `verified: false` when the sign-in wasn't requested on this device (a magic link the user confirmed):
   * signed-out notebooks are then only moved into the account when the user agrees (`localOffer`).
   */
  signInWithTokens(t: Tokens, profile: Profile, opts?: { verified?: boolean }): Promise<void>;
  /** Apple / Google: POST the identity token to `path`. */
  signInWith(path: string, body: unknown, profile: Profile): Promise<void>;
  signOut(): Promise<void>;
  /** Signed-out notebooks on this device waiting for the user's OK to move into this account (0: none). */
  localOffer: number;
  moveLocal(): Promise<void>;
  dismissLocalOffer(): void;
}

/** Set while the account was signed in through a link this device didn't ask for; cleared once the user moves local notebooks. */
const unverifiedKey = (userId: string) => `auth:unverified:${userId}`;

const Ctx = React.createContext<Session | null>(null);

function remoteFor(tm: TokenManager, serverUrl: string): RemoteFactory {
  const authed = (p: string, i?: RequestInit) => tm.fetch(p, i);
  return (docId, doc) => (docId === LOCAL_LIBRARY ? null : new SyncProvider(doc, docId, { serverUrl, getTicket: (id) => fetchTicket(authed, id) }));
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const serverUrl = config.serverUrl;
  const tm = React.useMemo(() => (serverUrl ? new TokenManager(serverUrl, tokenStore) : null), [serverUrl]);
  const dm = React.useMemo(() => new DocManager({ persist: openPersistence, remote: null }), []);
  const tmRef = React.useRef<TokenManager | null>(null);
  const [user, setUser] = React.useState<User | null>(null);
  const assets = React.useMemo(() => new AssetService(() => (tmRef.current?.user() ? tmRef.current : null)), []);
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [ready, setReady] = React.useState(false);
  const [skipped, setSkippedState] = React.useState(false);
  const [library, setLibrary] = React.useState<Library | null>(null);
  const [localOffer, setLocalOffer] = React.useState(0);
  tmRef.current = tm;

  // Load tokens and prefs.
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      const [u, p, s] = await Promise.all([tm ? tm.load() : Promise.resolve(null), kvGet<Profile>('profile'), kvGet<boolean>('auth:skipped')]);
      if (!alive) return;
      setUser(u);
      setProfile(p ?? null);
      setSkippedState(!!s);
      setReady(true);
    })();
    const off = tm?.onChange((u) => setUser(u));
    return () => {
      alive = false;
      off?.();
    };
  }, [tm]);

  // Sync on while signed in.
  React.useEffect(() => {
    dm.setRemote(tm && serverUrl && user ? remoteFor(tm, serverUrl) : null);
    if (user) void assets.uploadPending();
  }, [dm, tm, serverUrl, user?.id, assets]);

  // The library doc for the current account.
  const libraryDocId = user ? docIds.library(user.id) : LOCAL_LIBRARY;
  React.useEffect(() => {
    if (!ready) return;
    let alive = true;
    let handle: DocHandle | null = null;
    void (async () => {
      const h = await openLoaded(dm, libraryDocId, user ? 2500 : 0);
      if (!alive) {
        h.release();
        return;
      }
      handle = h;
      const lib = new Library(h.doc);
      if (user) {
        // On every sign-in and app start: notebooks made here while signed out go into the account (and leave lib:local),
        // unless this sign-in wasn't requested on this device; then the user is asked first.
        const local = await openLoaded(dm, LOCAL_LIBRARY);
        const ll = new Library(local.doc);
        const n = localToMove(lib, ll);
        if (n > 0 && (await kvGet<boolean>(unverifiedKey(user.id)))) {
          if (alive) setLocalOffer(n);
        } else if (ll.entries().length) {
          moveLocalLibrary(lib, ll);
        }
        local.release();
      }
      if (alive) setLibrary(lib);
    })();
    return () => {
      alive = false;
      setLibrary(null);
      setLocalOffer(0);
      handle?.release();
    };
  }, [dm, libraryDocId, ready, user?.id]);

  const moveLocal = React.useCallback(async () => {
    if (!library || !user) return;
    const local = await openLoaded(dm, LOCAL_LIBRARY);
    moveLocalLibrary(library, new Library(local.doc));
    local.release();
    await kvSet(unverifiedKey(user.id), undefined);
    setLocalOffer(0);
  }, [dm, library, user?.id]);

  const dismissLocalOffer = React.useCallback(() => setLocalOffer(0), []);

  const setSkipped = React.useCallback((v: boolean) => {
    setSkippedState(v);
    void kvSet('auth:skipped', v);
  }, []);

  const signInWithTokens = React.useCallback(
    async (t: Tokens, p: Profile, opts?: { verified?: boolean }) => {
      if (!tm) throw new Error('No server configured');
      const sub = decodeJwt(t.accessToken).sub;
      if (!sub) throw new Error('Sign-in returned no account');
      // Switching accounts: end the old session on the server first.
      if (tm.user()) {
        await dm.flushAll();
        await tm.revoke();
      }
      await kvSet(unverifiedKey(sub), opts?.verified === false ? true : undefined);
      await kvSet('profile', p);
      setProfile(p);
      await tm.setTokens(t);
    },
    [dm, tm],
  );

  const signInWith = React.useCallback(
    async (path: string, body: unknown, p: Profile) => {
      if (!tm) throw new Error('No server configured');
      if (tm.user()) {
        await dm.flushAll();
        await tm.revoke();
      }
      await kvSet('profile', p);
      setProfile(p);
      const u = await tm.signIn(path, body);
      await kvSet(unverifiedKey(u.id), undefined);
    },
    [dm, tm],
  );

  const signOut = React.useCallback(async () => {
    await dm.flushAll();
    const id = tm?.user()?.id;
    // Ends the server session too (best effort: offline still signs out here).
    await tm?.logout();
    if (id) await kvSet(unverifiedKey(id), undefined);
    await kvSet('profile', undefined);
    setProfile(null);
  }, [dm, tm]);

  const value = React.useMemo<Session>(
    () => ({ serverUrl, tm, user, profile, ready, skipped, setSkipped, dm, assets, library, signInWithTokens, signInWith, signOut, localOffer, moveLocal, dismissLocalOffer }),
    [serverUrl, tm, user, profile, ready, skipped, setSkipped, dm, assets, library, signInWithTokens, signInWith, signOut, localOffer, moveLocal, dismissLocalOffer],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const v = React.useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

/** Re-renders when `subscribe` fires; returns a counter to use as a memo dependency. */
export function useVersion(subscribe: ((cb: () => void) => () => void) | null): number {
  const [v, setV] = React.useState(0);
  React.useEffect(() => {
    if (!subscribe) return;
    return subscribe(() => setV((x) => x + 1));
  }, [subscribe]);
  return v;
}

export function useLibraryData(): { library: Library | null; entries: LibraryEntry[]; folders: Folder[] } {
  const { library } = useSession();
  const sub = React.useMemo(() => (library ? (cb: () => void) => library.observe(cb) : null), [library]);
  const v = useVersion(sub);
  return React.useMemo(
    () => ({ library, entries: library?.entries() ?? [], folders: library?.folders() ?? [] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [library, v],
  );
}

/** Holds a doc open (ref-counted) while mounted. `null` until local state is loaded. */
export function useDoc(docId: string | null, syncTimeoutMs = 0): DocHandle | null {
  const { dm } = useSession();
  const [h, setH] = React.useState<DocHandle | null>(null);
  React.useEffect(() => {
    if (!docId) return;
    let alive = true;
    let handle: DocHandle | null = null;
    void openLoaded(dm, docId, syncTimeoutMs).then((x) => {
      if (!alive) return x.release();
      handle = x;
      setH(x);
    });
    return () => {
      alive = false;
      setH(null);
      handle?.release();
    };
  }, [dm, docId, syncTimeoutMs]);
  return h;
}

/** Live sync status of a doc (null when offline-only). */
export function useSyncStatus(h: DocHandle | null): SyncStatus | null {
  const { dm } = useSession();
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => dm.onRemoteChange(force), [dm]);
  const p = h?.provider() ?? null;
  const [status, setStatus] = React.useState<SyncStatus | null>(p?.status ?? null);
  React.useEffect(() => {
    setStatus(p?.status ?? null);
    return p?.onStatus(setStatus);
  }, [p]);
  return p ? status : null;
}
