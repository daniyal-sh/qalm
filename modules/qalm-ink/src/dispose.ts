/**
 * Frees Skia objects (paths, pictures, images) a little later. Skia's reconciler can still be drawing the previous
 * frame's objects for a few frames after React commits (on web it is asynchronous), so freeing immediately is unsafe.
 * On web nothing else frees them: CanvasKit objects live in WASM memory with no finalizer.
 */
const DELAY_MS = 1500;

type Disposable = { dispose?: () => void } | null | undefined;
let queue: { o: Disposable; at: number }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function run(): void {
  timer = null;
  const now = Date.now();
  const due = queue.filter((x) => now - x.at >= DELAY_MS);
  queue = queue.filter((x) => now - x.at < DELAY_MS);
  for (const { o } of due) {
    try {
      o?.dispose?.();
    } catch {
      // already freed
    }
  }
  if (queue.length) timer = setTimeout(run, DELAY_MS - (now - queue[0]!.at));
}

export function disposeLater(...objs: Disposable[]): void {
  const at = Date.now();
  for (const o of objs) if (o) queue.push({ o, at });
  if (!timer && queue.length) timer = setTimeout(run, DELAY_MS);
}
