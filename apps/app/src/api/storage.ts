/**
 * The account's storage cap (GET /me/storage): uploaded PDFs and images plus notebook data, 250 MB in the free beta.
 * Only imports are refused at the cap; handwriting and other edits always sync.
 */
export interface StorageUsage {
  usedBytes: number;
  limitBytes: number;
  assetBytes: number;
  notebookBytes: number;
}

type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export async function getStorage(fetchFn: AuthedFetch): Promise<StorageUsage> {
  const res = await fetchFn('/me/storage');
  if (!res.ok) throw new Error(`Couldn't load storage (${res.status})`);
  return (await res.json()) as StorageUsage;
}

/** An import that doesn't fit in the account's storage. */
export class StorageFullError extends Error {
  constructor(readonly usage: StorageUsage | null, message?: string) {
    super(message ?? storageFullMessage(usage?.limitBytes));
    this.name = 'StorageFullError';
  }
}

export function storageFullMessage(limitBytes = 250_000_000): string {
  return `Your qalm storage is full (${formatBytes(limitBytes)}). Delete some PDFs or images to import more. Your handwriting keeps syncing.`;
}

/** Decimal units, like the cap itself: "120 MB", "1.2 GB", "640 KB". */
export function formatBytes(n: number): string {
  if (n < 1000) return `${Math.max(0, Math.round(n))} B`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} KB`;
  if (n < 1_000_000_000) {
    const mb = n / 1_000_000;
    return `${mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)} MB`;
  }
  return `${Math.round(n / 100_000_000) / 10} GB`;
}

export const WARN_AT = 0.9;

export interface UsageSummary {
  /** "120 MB of 250 MB" */
  label: string;
  /** 0..1, for the bar */
  fraction: number;
  /** Above 90 %: a gentle warning. */
  warn: boolean;
  /** At or over the cap: imports are refused. */
  full: boolean;
}

export function summarizeUsage(u: StorageUsage): UsageSummary {
  const fraction = u.limitBytes > 0 ? Math.min(1, u.usedBytes / u.limitBytes) : 1;
  return {
    label: `${formatBytes(u.usedBytes)} of ${formatBytes(u.limitBytes)}`,
    fraction,
    warn: fraction > WARN_AT,
    full: u.usedBytes >= u.limitBytes,
  };
}

/** Whether an import of `bytes` fits (the server makes the same check and answers 413 if not). */
export const fits = (u: StorageUsage, bytes: number) => u.usedBytes + bytes <= u.limitBytes;
