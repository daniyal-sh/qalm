// Expo config plugin: signs Android release builds with your release keystore instead of the debug key.
// The keystore lives outside the repo. Its properties file (storeFile, storePassword, keyAlias, keyPassword) is at
// QALM_ANDROID_KEYSTORE_PROPERTIES, default ~/.qalm/android/keystore.properties. When that file is missing at prebuild
// time, the template's debug signing is left as is. The generated build.gradle reads the file at build time, so the
// password never enters android/ or the repo, and it falls back to debug signing if the file has since disappeared.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// qalm release signing';

function propertiesPath() {
  return path.resolve(
    process.env.QALM_ANDROID_KEYSTORE_PROPERTIES || path.join(os.homedir(), '.qalm', 'android', 'keystore.properties'),
  );
}

function applySigning(gradle, propsFile) {
  if (gradle.includes(MARKER)) return gradle;
  const literal = JSON.stringify(propsFile.replace(/\\/g, '/'));
  const header = [
    MARKER,
    `def qalmKeystorePropertiesFile = file(${literal})`,
    'def qalmKeystoreProperties = new Properties()',
    'if (qalmKeystorePropertiesFile.exists()) {',
    '    qalmKeystorePropertiesFile.withInputStream { qalmKeystoreProperties.load(it) }',
    '}',
    '',
  ].join('\n');

  const androidBlock = /^android\s*\{/m;
  if (!androidBlock.test(gradle)) throw new Error('with-release-signing: no android { } block in app/build.gradle');
  gradle = gradle.replace(androidBlock, (m) => `${header}${m}`);

  const signingConfigs = /signingConfigs\s*\{\n/;
  if (!signingConfigs.test(gradle)) throw new Error('with-release-signing: no signingConfigs { } in app/build.gradle');
  gradle = gradle.replace(
    signingConfigs,
    (m) =>
      m +
      [
        '        if (qalmKeystorePropertiesFile.exists()) {',
        '            release {',
        "                storeFile file(qalmKeystoreProperties['storeFile'])",
        "                storePassword qalmKeystoreProperties['storePassword']",
        "                keyAlias qalmKeystoreProperties['keyAlias']",
        "                keyPassword qalmKeystoreProperties['keyPassword']",
        '            }',
        '        }',
        '',
      ].join('\n'),
  );

  const releaseSigning = /(release\s*\{[^}]*?)signingConfig signingConfigs\.debug/;
  if (!releaseSigning.test(gradle)) throw new Error('with-release-signing: no release signingConfig in app/build.gradle');
  return gradle.replace(
    releaseSigning,
    '$1signingConfig qalmKeystorePropertiesFile.exists() ? signingConfigs.release : signingConfigs.debug',
  );
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    const propsFile = propertiesPath();
    if (!fs.existsSync(propsFile)) {
      console.warn(`with-release-signing: ${propsFile} not found; release builds use the debug key`);
      return cfg;
    }
    if (cfg.modResults.language !== 'groovy') throw new Error('with-release-signing: expected a Groovy build.gradle');
    cfg.modResults.contents = applySigning(cfg.modResults.contents, propsFile);
    return cfg;
  });
};
