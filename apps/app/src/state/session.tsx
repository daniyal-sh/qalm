/**
 * App-wide services: auth tokens, the doc manager (local persistence + sync), assets and the user's
 * library doc. Signed out (or with no server configured) everything works locally under `lib:local`.
 */
import { Library, type Folder, type LibraryEntry } from '@qalm/core';
import * as React from 'react';

import { AssetService } from '../assets/assetService';
import { TokenManager, type Tokens, type User } from '../auth/tokens';
import { tokenStore } from '../auth/tokenStore';
import { config } from '../config';
import { mergeLibrary } from '../library/actions';
import { kvGet, kvSet } from '../lib/kv';
import { DocManager, docIds, openLoaded, type DocHandle, type RemoteFactory } from '../sync/docs';
import { openPersistence } from '../sync/persistence';
import { SyncProvider, type SyncStatus } from '../sync/provider';
import { fetchTicket } from '../sync/ticket';

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
  signInWithTokens(t: Tokens, profile: Profile): Promise<void>;
  /** Apple / Google: POST the identity token to `path`. */
  signInWith(path: string, body: unknown, profile: Profile): Promise<void>;
  signOut(): Promise<void>;
}

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
      if (user && !(await kvGet<boolean>(`merged:${user.id}`))) {
        // First sign-in on this device: bring notebooks made while signed out into the account.
        const local = await openLoaded(dm, LOCAL_LIBRARY);
        mergeLibrary(lib, new Library(local.doc));
        local.release();
        await kvSet(`merged:${user.id}`, true);
      }
      if (alive) setLibrary(lib);
    })();
    return () => {
      alive = false;
      setLibrary(null);
      handle?.release();
    };
  }, [dm, libraryDocId, ready, user?.id]);

  const setSkipped = React.useCallback((v: boolean) => {
    setSkippedState(v);
    void kvSet('auth:skipped', v);
  }, []);

  const signInWithTokens = React.useCallback(
    async (t: Tokens, p: Profile) => {
      if (!tm) throw new Error('No server configured');
      await kvSet('profile', p);
      setProfile(p);
      await tm.setTokens(t);
    },
    [tm],
  );

  const signInWith = React.useCallback(
    async (path: string, body: unknown, p: Profile) => {
      if (!tm) throw new Error('No server configured');
      await kvSet('profile', p);
      setProfile(p);
      await tm.signIn(path, body);
    },
    [tm],
  );

  const signOut = React.useCallback(async () => {
    await dm.flushAll();
    await tm?.signOut();
    await kvSet('profile', undefined);
    setProfile(null);
  }, [dm, tm]);

  const value = React.useMemo<Session>(
    () => ({ serverUrl, tm, user, profile, ready, skipped, setSkipped, dm, assets, library, signInWithTokens, signInWith, signOut }),
    [serverUrl, tm, user, profile, ready, skipped, setSkipped, dm, assets, library, signInWithTokens, signInWith, signOut],
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
