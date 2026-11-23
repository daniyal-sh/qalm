// electron-builder (tech-spec §6). Nothing is signed with real certificates here: Windows signing needs
// CSC_LINK/WIN_CSC_LINK, macOS signing CSC_LINK + CSC_KEY_PASSWORD. Notarization runs only when Apple
// credentials are in the environment (APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or
// APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID).
const env = process.env;
const notarize = !!(
  (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) ||
  (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)
);

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.apollo.qalm',
  productName: 'Apollo Qalm',
  copyright: 'Copyright © Apollo',
  directories: { output: 'release', buildResources: 'resources' },
  files: ['dist/**/*.js', 'package.json'],
  // The Expo web export, served by the app:// protocol from resources/web.
  extraResources: [{ from: '../app/dist', to: 'web', filter: ['**/*'] }],
  asar: true,
  npmRebuild: false,
  protocols: [{ name: 'Qalm', schemes: ['qalm'] }],
  win: {
    icon: 'resources/icons/icon.ico',
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
    executableName: 'Qalm',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: 'Qalm',
    artifactName: 'Apollo-Qalm-Setup-${version}-${arch}.${ext}',
  },
  mac: {
    icon: 'resources/icons/icon.icns',
    category: 'public.app-category.productivity',
    target: [{ target: 'dmg', arch: ['universal'] }],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'resources/entitlements.mac.plist',
    entitlementsInherit: 'resources/entitlements.mac.plist',
    notarize,
  },
  dmg: { artifactName: 'Apollo-Qalm-${version}-${arch}.${ext}' },
};
