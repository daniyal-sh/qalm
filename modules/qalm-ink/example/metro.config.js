// Let Metro see the module (..) and the workspace's node_modules. Works with pnpm's isolated
// layout (deps resolved through ../node_modules) and with a hoisted root node_modules.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const moduleRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(__dirname, '../../..');

const config = getDefaultConfig(__dirname);
config.watchFolders = [moduleRoot, workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.join(moduleRoot, 'node_modules'),
  path.join(workspaceRoot, 'node_modules'),
];

// pdf-lib (via @qalm/core) ships tslib 1.x, whose ESM entry (`modules/index.js`) default-imports a CJS file and
// crashes under Metro ("Cannot destructure property '__extends'"). Use its plain ES build instead.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'isomorphic-webcrypto/src/react-native') {
    return { type: 'sourceFile', filePath: path.join(__dirname, 'webcrypto-shim.js') };
  }
  const res = context.resolveRequest(context, moduleName, platform);
  if (moduleName === 'tslib' && res.type === 'sourceFile' && /[\\/]tslib[\\/]modules[\\/]index\.js$/.test(res.filePath)) {
    return { type: 'sourceFile', filePath: path.join(path.dirname(res.filePath), '..', 'tslib.es6.js') };
  }
  return res;
};

module.exports = config;
