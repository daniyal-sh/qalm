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

module.exports = config;
