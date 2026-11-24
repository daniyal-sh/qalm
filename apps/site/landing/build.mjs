// Builds the site's static pages into apps/site/public/ (scripts/build.mjs then copies public/ into dist/).
//
//   index.html                  the landing page (template.html + generated ink)
//   privacy.html, terms.html,   the legal pages (legal.mjs), served at /privacy, /terms, /data-rights
//   data-rights.html
//   contact.html                /contact
//   404.html                    any missing path outside /app
//   download/unavailable.html   what /download/windows|android show until the installer is in R2 (src/worker.js)
//   favicon.svg, robots.txt, sitemap.xml
//
// og.png and apple-touch-icon.png need a browser, so they come from og.mjs (run it after changing the hero).
// Usage: node landing/build.mjs [outDir]    (default: ../public). The output is deterministic.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderLanding } from './landing.mjs';
import { legalPages, render404, renderContact, renderLegal, renderUnavailable } from './pages.mjs';
import { ORIGIN, SITEMAP, faviconSvg } from './site.mjs';

const out = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('../public/', import.meta.url));
const LASTMOD = '2026-11-24';

const files = {};
const landing = renderLanding();
files['index.html'] = landing.html;
files['privacy.html'] = renderLegal(legalPages.privacy);
files['terms.html'] = renderLegal(legalPages.terms);
files['data-rights.html'] = renderLegal(legalPages.dataRights);
files['contact.html'] = renderContact();
files['404.html'] = render404();
files['download/unavailable.html'] = renderUnavailable();
files['favicon.svg'] = faviconSvg();
files['robots.txt'] = `# qalm.apollolearn.app\nUser-agent: *\nAllow: /\nDisallow: /app/\nDisallow: /download/\n\nSitemap: ${ORIGIN}/sitemap.xml\n`;
files['sitemap.xml'] =
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  SITEMAP.map((p) => `  <url><loc>${ORIGIN}${p}</loc><lastmod>${LASTMOD}</lastmod></url>`).join('\n') +
  '\n</urlset>\n';

for (const [name, body] of Object.entries(files)) {
  const file = path.join(out, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' KB';
console.log(`landing: ${out}`);
for (const [name, body] of Object.entries(files)) console.log(`  ${name.padEnd(28)} ${kb(body)}`);
console.log(`  (the hero writes for ${landing.end.toFixed(1)} s)`);
