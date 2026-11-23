// Notebooks made on this device while signed out (`lib:local`) and moving them into an account library.
import type { Library } from '@qalm/core';

import { mergeLibrary } from '../library/actions';

/** How many signed-out notebooks are not in the account library yet. */
export function localToMove(account: Library, local: Library): number {
  return local.entries().filter((e) => !account.entry(e.id)).length;
}

/** True when `lib:local` holds anything to move: notebooks, or colours saved while signed out. */
export function hasLocalLibrary(local: Library): boolean {
  return local.entries().length > 0 || local.hasCustomSwatches('pen') || local.hasCustomSwatches('highlighter');
}

/**
 * Moves every signed-out notebook into the account library (folders matched by name) and removes them from
 * `lib:local`, so they are listed once and not offered again. Saved colours go along (the account's first, then
 * the signed-out ones it lacks) and `lib:local` goes back to the default palette. Returns how many notebooks were
 * added to the account.
 */
export function moveLocalLibrary(account: Library, local: Library): number {
  const n = mergeLibrary(account, local);
  account.mergeSwatchesFrom(local);
  local.doc.transact(() => {
    local.resetSwatches('pen');
    local.resetSwatches('highlighter');
    for (const e of local.entries()) if (account.entry(e.id)) local.removeEntry(e.id);
    const used = new Set(local.entries().map((e) => e.folderId));
    for (const f of local.folders()) if (!used.has(f.id)) local.removeFolder(f.id);
  });
  return n;
}
