// app.json plus the web base path. The Cloudflare site (apps/site) builds the web app with QALM_WEB_BASE_URL=/app, so it
// is served at https://qalm.apollolearn.app/app/. Unset (the default) keeps the web app at the root: `expo start --web`,
// `export:web` and the desktop app (app://qalm/). Native builds never set it.
module.exports = ({ config }) => {
  const baseUrl = (process.env.QALM_WEB_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) return config;
  if (!baseUrl.startsWith('/')) throw new Error(`QALM_WEB_BASE_URL must start with "/" (got ${baseUrl})`);
  return { ...config, experiments: { ...config.experiments, baseUrl } };
};
