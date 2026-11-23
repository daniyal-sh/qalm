/**
 * Destructive confirmations ("Delete page 3?"). Every platform shows the same in-app dialog (`ConfirmHost`, mounted
 * once in the root layout) with a real action label instead of the browser's "OK".
 */
export interface ConfirmRequest {
  title: string;
  body: string;
  /** The destructive button's label: "Delete", "Sign out", "Turn off"… */
  action: string;
  onYes(): void;
}

type Listener = (req: ConfirmRequest | null) => void;

let current: ConfirmRequest | null = null;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(current);
}

/** Ask before doing something destructive. A newer request replaces one still open. */
export function confirm(title: string, body: string, action: string, onYes: () => void): void {
  current = { title, body, action, onYes };
  emit();
}

/** The open request, if any. */
export function pendingConfirm(): ConfirmRequest | null {
  return current;
}

/** Close the dialog; `yes` runs the action. */
export function settleConfirm(yes: boolean): void {
  const req = current;
  if (!req) return;
  current = null;
  emit();
  if (yes) req.onYes();
}

export function subscribeConfirm(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
