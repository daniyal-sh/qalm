// Expo detects the pnpm workspace (hoisted node_modules at the root) and watches it.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// pdf.js (qalm-ink web) ships .mjs files.
if (!config.resolver.sourceExts.includes('mjs')) config.resolver.sourceExts.push('mjs');

module.exports = config;
