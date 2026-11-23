// Stand-in for `isomorphic-webcrypto/src/react-native`, which lib0 (yjs) imports on iOS/Android but which isn't
// installed. Yjs only needs getRandomValues (Y.Doc client ids); expo-crypto provides a secure native one.
// SubtleCrypto isn't used anywhere in the app.
const { getRandomValues } = require('expo-crypto');

module.exports = {
  ensureSecure() {},
  subtle: undefined,
  getRandomValues: (a) => getRandomValues(a),
};
