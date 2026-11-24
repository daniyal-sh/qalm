// What every page on qalm.apollolearn.app shares: facts about the site, the <head>, the header and footer, the mark,
// icons and the shared CSS.
import fs from 'node:fs';

export const ORIGIN = 'https://qalm.apollolearn.app';

/** The person who operates qalm (as for Apollo: not a registered company). Every legal page reads from it. */
export const legalEntity = { name: 'Ali Hamdaan', location: 'Pakistan' };
export const privacyEmail = 'privacy@apollolearn.app';
export const supportEmail = 'support@apollolearn.app';
/** "Last updated" on the legal pages. */
export const UPDATED = 'November 24, 2026';
export const YEAR = 2026;

/** Footer links, on every page. */
export const FOOTER_LINKS = [
  ['/privacy', 'Privacy'],
  ['/terms', 'Terms'],
  ['/data-rights', 'Data rights'],
  ['/contact', 'Contact'],
];

/** Pages for sitemap.xml. */
export const SITEMAP = ['/', '/privacy', '/terms', '/data-rights', '/contact'];

export const SHARED_CSS = fs.readFileSync(new URL('./shared.css', import.meta.url), 'utf8').trim();

/** The honest note under the download buttons. */
export const BUILD_NOTE =
  '<b>Early builds, not yet signed.</b> On Windows, SmartScreen may warn you: choose <b>More info</b>, then <b>Run anyway</b>. ' +
  'On Android, allow installs from your browser when it asks.';

const MARK_SRC = fs.readFileSync(new URL('../../../assets/brand/qalm-mark.svg', import.meta.url), 'utf8').replace(/<!--.*?-->\s*/s, '');

/** The mark, coloured by the theme tokens. `id` keeps its mask unique on a page that shows it twice. */
export function mark(id) {
  return MARK_SRC.replace('<svg ', '<svg class="mark" aria-hidden="true" focusable="false" ')
    .replace(' xmlns="http://www.w3.org/2000/svg"', '')
    .replaceAll('qalm-ring', `qalm-ring-${id}`)
    .replace(/stroke="#4338CA"/g, 'class="orbit"')
    .replace(/stroke="#27272A"/g, 'class="nib"')
    .replace(/fill="#27272A"/g, 'class="nibfill"')
    .replace(/fill="#1D4ED8"/g, 'class="planet"')
    .replace(/\n\s*/g, '');
}

/** favicon.svg: the mark, with a light nib on dark browser chrome. */
export function faviconSvg() {
  return MARK_SRC.replace(
    /(<svg[^>]*>)/,
    '$1<style>@media (prefers-color-scheme:dark){.n{stroke:#f4f4f5}.f{fill:#f4f4f5}.o{stroke:#6d63f4}.p{fill:#60a5fa}}</style>',
  )
    .replace(/stroke="#27272A"/g, 'stroke="#27272A" class="n"')
    .replace(/fill="#27272A"/g, 'fill="#27272A" class="f"')
    .replace(/stroke="#4338CA"/g, 'stroke="#4338CA" class="o"')
    .replace(/fill="#1D4ED8"/g, 'fill="#1D4ED8" class="p"')
    .replace(/\n\s*/g, '')
    .concat('\n');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Everything in <head> except the page's own <style>. */
export function head({ title, description, path, ogTitle = title, noindex = false }) {
  const url = ORIGIN + path;
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${url}">`,
    '<meta name="color-scheme" content="light dark">',
    '<meta name="theme-color" content="#f6f6f8" media="(prefers-color-scheme: light)">',
    '<meta name="theme-color" content="#151517" media="(prefers-color-scheme: dark)">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="qalm by Apollo">',
    `<meta property="og:title" content="${esc(ogTitle)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${ORIGIN}/og.png">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    `<meta property="og:image:alt" content="qalm: a handwriting app that doesn't suck. A notebook page of handwritten notes.">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(ogTitle)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    `<meta name="twitter:image" content="${ORIGIN}/og.png">`,
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap">',
  ].join('\n');
}

/** The site header. The landing page shows its section links; other pages link home. */
export function header({ landing = false } = {}) {
  const nav = landing
    ? '<nav class="site-nav" aria-label="Sections"><a href="#pen">Pen</a><a href="#notebooks">Notebooks</a><a href="#sync">Sync</a><a href="#ai">AI</a></nav>'
    : '<nav class="site-nav" aria-label="Site"><a href="/">Home</a><a href="/#pen">Features</a></nav>';
  return `<header class="site-head">
  <div class="wrap">
    <a class="lockup" href="/" aria-label="qalm by Apollo, home">${mark('head')}<span class="name"><b>qalm</b><small>by Apollo</small></span></a>
    ${nav}
    <a class="btn btn-sm" href="/app/">Open qalm</a>
  </div>
</header>`;
}

export function footer() {
  return `<footer class="site-foot">
  <div class="wrap">
    <a class="lockup" href="/" aria-label="qalm by Apollo, home">${mark('foot')}<span class="name"><b>qalm</b><small>by Apollo</small></span></a>
    <nav aria-label="Legal and contact">${FOOTER_LINKS.map(([href, label]) => `<a href="${href}">${label}</a>`).join('')}</nav>
    <p class="copy">© ${YEAR} Apollo. Made for people who think with a pen.</p>
  </div>
</footer>`;
}

/** A 24px line icon. */
export const icon = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const ICONS = {
  windows: icon('<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  android: icon('<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M11 16h2"/>'),
  ipad: icon('<rect x="5" y="2.5" width="14" height="19" rx="2.5"/><path d="M11 18.5h2"/>'),
  mac: icon('<rect x="4" y="4" width="16" height="11" rx="1.5"/><path d="M2 19h20l-1.5-4h-17z"/>'),
  web: icon('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 3 3.5 6 3.5 9s-1 6-3.5 9c-2.5-3-3.5-6-3.5-9s1-6 3.5-9z"/>'),
  download: icon('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  mail: icon('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>'),
  shield: icon('<path d="M12 3 4.5 6v6c0 4.4 3.2 7.8 7.5 9 4.3-1.2 7.5-4.6 7.5-9V6z"/><path d="m9 12 2 2 4-4"/>'),
  arrow: '<svg class="arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  cross: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
};

/** Fills {{KEY}} placeholders; every key must be present. */
export function fill(html, values) {
  for (const [k, v] of Object.entries(values)) {
    if (!html.includes(`{{${k}}}`)) throw new Error(`missing {{${k}}}`);
    html = html.replaceAll(`{{${k}}}`, String(v));
  }
  const left = html.match(/\{\{[A-Z0-9_]+\}\}/);
  if (left) throw new Error(`unfilled ${left[0]}`);
  return html;
}
