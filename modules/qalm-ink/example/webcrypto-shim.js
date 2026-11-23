// Example-only stand-in for `isomorphic-webcrypto/src/react-native`, which lib0 (yjs) imports on native but which
// isn't installed. The example never syncs; it only needs getRandomValues for Y.Doc client ids.
module.exports = {
  ensureSecure() {},
  subtle: undefined,
  getRandomValues(a) {
    if (globalThis.crypto && globalThis.crypto.getRandomValues) return globalThis.crypto.getRandomValues(a);
    const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < b.length; i++) b[i] = (Math.random() * 256) | 0;
    return a;
  },
};
