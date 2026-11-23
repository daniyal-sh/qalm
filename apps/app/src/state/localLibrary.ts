// Notebooks made on this device while signed out (`lib:local`) and moving them into an account library.
import type { Library } from '@qalm/core';

import { mergeLibrary } from '../library/actions';

/** How many signed-out notebooks are not in the account library yet. */
export function localToMove(account: Library, local: Library): number {
  return local.entries().filter((e) => !account.entry(e.id)).length;
}

/**
 * Moves every signed-out notebook into the account library (folders matched by name) and removes them from
 * `lib:local`, so they are listed once and not offered again. Returns how many were added to the account.
 */
export function moveLocalLibrary(account: Library, local: Library): number {
  const n = mergeLibrary(account, local);
  local.doc.transact(() => {
    for (const e of local.entries()) if (account.entry(e.id)) local.removeEntry(e.id);
    const used = new Set(local.entries().map((e) => e.folderId));
    for (const f of local.folders()) if (!used.has(f.id)) local.removeFolder(f.id);
  });
  return n;
}
