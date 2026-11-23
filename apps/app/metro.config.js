// Expo detects the pnpm workspace (hoisted node_modules at the root) and watches it.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// pdf.js (qalm-ink web) ships .mjs files.
if (!config.resolver.sourceExts.includes('mjs')) config.resolver.sourceExts.push('mjs');

// pdf-lib depends on tslib 1.x, whose package exports send Metro to `modules/index.js`, which
// default-imports a CommonJS file and crashes on web ("Cannot destructure '__extends'").
// Resolve tslib to its plain CommonJS build instead.
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'tslib') {
    // Node's resolution picks the "require" condition: tslib.js.
    return { type: 'sourceFile', filePath: require.resolve('tslib', { paths: [path.dirname(context.originModulePath)] }) };
  }
  return (upstream ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
