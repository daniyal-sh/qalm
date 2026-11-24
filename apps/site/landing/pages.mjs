// The site's other pages, in the landing page's design: Privacy, Terms, Data rights (Apollo's legal-page structure),
// Contact, the 404 page, and the "not available yet" page for a missing download.
import { layout, penStroke, rng } from './ink.mjs';
import { underline } from './landing.mjs';
import { legalPages } from './legal.mjs';
import { ICONS, SHARED_CSS, footer, head, header, legalEntity, privacyEmail, supportEmail } from './site.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Text with the support and privacy addresses turned into links. */
const linkify = (s) =>
  esc(s).replace(/([a-z]+@apollolearn\.app)/g, '<a href="mailto:$1">$1</a>').replace(/\bico\.org\.uk\b/g, '<a href="https://ico.org.uk">ico.org.uk</a>');

const PAGE_CSS = `
/* ---------- pages ---------- */
.kicker{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:500;color:var(--muted)}
.doc-hero{border-bottom:1px solid var(--line-2);padding:clamp(28px,5vw,72px) 0 clamp(36px,5vw,64px)}
.doc-hero h1{font-size:clamp(40px,6vw,72px);line-height:1;letter-spacing:-.04em;font-weight:600;margin:16px 0 0;max-width:14em;text-wrap:balance}
.doc-hero .lead{font-size:clamp(17px,1.5vw,19px);color:var(--muted);line-height:1.6;margin-top:20px;max-width:38em}
.updated{display:inline-block;margin-top:26px;padding-bottom:4px;border-bottom:2px solid var(--accent);font-size:14px;font-weight:600}
.doc{display:grid;grid-template-columns:15rem minmax(0,1fr);gap:clamp(32px,6vw,72px);padding-block:clamp(36px,5vw,64px) clamp(56px,7vw,96px)}
.toc{position:sticky;top:24px;align-self:start;border-top:1px solid var(--line)}
.toc a{display:flex;align-items:center;gap:12px;min-height:44px;padding:6px 0;border-bottom:1px solid var(--line-2);font-size:14px;color:var(--muted);text-decoration:none;line-height:1.35}
.toc a:hover{color:var(--accent-ink)}
.num{font-family:var(--mono);font-size:12px;color:var(--accent-ink);font-variant-numeric:tabular-nums;flex:none}
.sections{max-width:46rem;border-top:1px solid var(--line)}
.sec{display:grid;grid-template-columns:3rem minmax(0,1fr);gap:12px;padding:clamp(28px,3.5vw,40px) 0;border-bottom:1px solid var(--line-2);scroll-margin-top:24px}
.sec:first-child{padding-top:24px}
.sec .num{padding-top:9px}
.sec h2{font-size:clamp(22px,2.4vw,28px);line-height:1.2;letter-spacing:-.02em;font-weight:600}
.sec p{margin-top:14px;font-size:16.5px;line-height:1.75;color:var(--muted)}
.sec ul{list-style:none;margin:16px 0 0;padding:0;display:grid;gap:12px}
.sec li{display:flex;gap:12px;font-size:16.5px;line-height:1.75;color:var(--muted)}
.sec li::before{content:"";width:6px;height:6px;margin-top:.8em;background:var(--accent);flex:none}
.prose a,.contact-band a{color:var(--accent-ink);font-weight:500;text-decoration:underline;text-underline-offset:3px}
.contact-band{border-top:1px solid var(--line-2);background:var(--surface);padding:clamp(36px,5vw,64px) 0}
.contact-band h2{font-size:clamp(24px,2.6vw,30px);letter-spacing:-.02em;font-weight:600}
.contact-band p{margin-top:12px;font-size:16px;line-height:1.7;color:var(--muted);max-width:46em}
@media (max-width:900px){
  .doc{grid-template-columns:1fr}
  .toc{position:static}
}
@media (max-width:640px){
  .sec{grid-template-columns:1fr;gap:4px}
  .sec .num{padding-top:0}
}

/* contact */
.ways{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;padding-block:clamp(36px,5vw,64px)}
.way{padding:clamp(22px,3vw,32px);display:flex;flex-direction:column;gap:10px}
.way .ic{width:44px;height:44px;border-radius:var(--r12);display:grid;place-items:center;background:var(--accent-soft);color:var(--accent-ink);margin-bottom:6px}
.way .ic svg{width:22px;height:22px}
.way h2{font-size:22px;letter-spacing:-.02em;font-weight:600}
.way p{font-size:16px;color:var(--muted);line-height:1.6}
.way .btn{align-self:flex-start;margin-top:8px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r12);box-shadow:var(--shadow-1)}
.small-print{padding-bottom:clamp(56px,7vw,96px);font-size:15px;color:var(--muted);line-height:1.7;max-width:46em}
@media (max-width:760px){.ways{grid-template-columns:1fr}}

/* 404 and "not available yet" */
.note-page{padding-block:clamp(28px,6vw,88px) clamp(64px,9vw,120px);display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);gap:clamp(32px,6vw,80px);align-items:center}
.note-page h1{font-size:clamp(38px,5vw,64px);line-height:1.02;letter-spacing:-.04em;font-weight:600;text-wrap:balance}
.note-page p{margin-top:18px;font-size:clamp(17px,1.5vw,19px);color:var(--muted);line-height:1.6;max-width:30em}
.note-page .actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:30px}
.scrap{background:#fff;border-radius:6px;box-shadow:var(--shadow-2);transform:rotate(-1.5deg);max-width:440px;width:100%;justify-self:center}
.scrap svg{width:100%;height:auto;display:block}
.scrap .pen-ink{fill:#27272a}
@media (max-width:820px){.note-page{grid-template-columns:1fr}.scrap{order:-1;max-width:320px}}
@media (max-width:640px){.note-page .actions .btn{flex:1 1 100%}}
`;

function page({ head: h, main, landingHeader = false }) {
  return `<!doctype html>
<html lang="en">
<head>
${h}
<style>
${SHARED_CSS}
${PAGE_CSS.trim()}
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${header({ landing: landingHeader })}
<main id="main">
${main}
</main>
${footer()}
</body>
</html>
`;
}

/** A legal page: hero, a numbered contents list, numbered sections, and a contact band (as on Apollo). */
export function renderLegal(c) {
  const sections = c.sections
    .map((s, i) => {
      const n = String(i + 1).padStart(2, '0');
      const paras = (typeof s.body === 'string' ? [s.body] : s.body ?? []).map((p) => `<p>${linkify(p)}</p>`).join('');
      const items = s.items?.length ? `<ul>${s.items.map((it) => `<li><span>${linkify(it)}</span></li>`).join('')}</ul>` : '';
      const after = s.after ? `<p>${linkify(s.after)}</p>` : '';
      return `<section class="sec prose" id="section-${i + 1}" aria-labelledby="h-${i + 1}"><span class="num" aria-hidden="true">${n}</span><div><h2 id="h-${i + 1}">${esc(s.title)}</h2>${paras}${items}${after}</div></section>`;
    })
    .join('\n      ');
  const toc = c.sections.map((s, i) => `<a href="#section-${i + 1}"><span class="num">${String(i + 1).padStart(2, '0')}</span>${esc(s.title)}</a>`).join('');
  const main = `  <article>
    <section class="doc-hero">
      <div class="wrap">
        <p class="kicker">${esc(c.kicker)}</p>
        <h1>${esc(c.title)}</h1>
        <p class="lead">${esc(c.lead)}</p>
        <p class="updated">Last updated: ${esc(c.updated)}</p>
      </div>
    </section>
    <div class="wrap doc">
      <nav class="toc" aria-label="${esc(c.title)} sections">${toc}</nav>
      <div class="sections">
      ${sections}
      </div>
    </div>
    ${contactBand()}
  </article>`;
  return page({ head: head({ title: `${c.title} · qalm`, description: c.description, path: c.path }), main });
}

function contactBand() {
  return `<section class="contact-band" aria-labelledby="contact-h">
      <div class="wrap">
        <h2 id="contact-h">Contact</h2>
        <p>Privacy questions and data requests: <a href="mailto:${privacyEmail}">${privacyEmail}</a>. Account help and anything else: <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
        <p>qalm is operated by ${legalEntity.name}, an individual based in ${legalEntity.location}.</p>
        <p>See also the <a href="/terms">Terms of Service</a>, <a href="/privacy">Privacy Notice</a>, and <a href="/data-rights">Data Rights</a>.</p>
      </div>
    </section>`;
}

export function renderContact() {
  const main = `  <section class="doc-hero">
    <div class="wrap">
      <p class="kicker">Contact</p>
      <h1>Get in touch.</h1>
      <p class="lead">Two addresses, both read by a person. We'll get back to you as soon as we can.</p>
    </div>
  </section>
  <div class="wrap">
    <div class="ways">
      <section class="card way" aria-labelledby="support-h">
        <span class="ic">${ICONS.mail}</span>
        <h2 id="support-h">Help and support</h2>
        <p>Trouble signing in, a bug, an idea, or anything about the apps.</p>
        <a class="btn" href="mailto:${supportEmail}">${supportEmail}</a>
      </section>
      <section class="card way" aria-labelledby="privacy-h">
        <span class="ic">${ICONS.shield}</span>
        <h2 id="privacy-h">Privacy and your data</h2>
        <p>Privacy questions, a copy of your data, or deleting your account.</p>
        <a class="btn" href="mailto:${privacyEmail}">${privacyEmail}</a>
      </section>
    </div>
    <p class="small-print prose">qalm is part of Apollo and is operated by ${legalEntity.name}, an individual based in ${legalEntity.location}. See the <a href="/privacy">Privacy Notice</a>, <a href="/terms">Terms of Service</a> and <a href="/data-rights">Data Rights</a>.</p>
  </div>`;
  return page({
    head: head({ title: 'Contact · qalm', description: `Contact qalm: ${supportEmail} for help, ${privacyEmail} for privacy and data requests.`, path: '/contact' }),
    main,
  });
}

/** A handwritten word on a scrap of paper (static ink). */
function scrap(word, seed, label) {
  const r = rng(seed);
  const l = layout(word.split(''), 30, 112, 0.92, r);
  const d = l.strokes.filter((s) => s.pts).map((s) => penStroke(s.pts, { size: 6.4, rand: r }).d);
  const w = Math.ceil(l.x + 30);
  const ul = underline().replace('<svg ', `<svg x="24" y="128" width="${w - 48}" height="16" `).replace('<path ', '<path fill="#4338ca" ');
  return `<div class="scrap" role="img" aria-label="${label}"><svg viewBox="0 0 ${w} 170"><rect width="${w}" height="170" fill="url(#dots)"/><g class="pen-ink">${d.map((x) => `<path d="${x}"/>`).join('')}</g>${ul}</svg></div>`;
}

const DOTS = '<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs><pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r="1.1" fill="#d9dce3"/></pattern></defs></svg>';

export function render404() {
  const main = `  ${DOTS}
  <div class="wrap note-page">
    <div>
      <h1>This page isn't here.</h1>
      <p>It may have moved, or the link has a typo. Your notebooks are fine.</p>
      <div class="actions">
        <a class="btn btn-primary" href="/">Back to home ${ICONS.arrow}</a>
        <a class="btn" href="/app/">Open qalm</a>
      </div>
    </div>
    ${scrap('oops!', 11, 'Handwritten: oops!')}
  </div>`;
  return page({ head: head({ title: 'Page not found · qalm', description: "This page isn't here.", path: '/404', noindex: true }), main, landingHeader: false });
}

/** Served by the Worker (status 404) when an installer isn't in R2; it swaps "This download" for the platform. */
export function renderUnavailable() {
  const main = `  ${DOTS}
  <div class="wrap note-page">
    <div>
      <h1><span data-platform>This download</span> isn't available yet.</h1>
      <p>We're putting the finishing touches on it. In the meantime, qalm runs right in your browser, and your notebooks sync to the apps once you install them.</p>
      <div class="actions">
        <a class="btn btn-primary" href="/app/">Open qalm in your browser ${ICONS.arrow}</a>
        <a class="btn" href="/">Back to home</a>
      </div>
    </div>
    ${scrap('soon!', 17, 'Handwritten: soon!')}
  </div>`;
  return page({ head: head({ title: 'Download not available yet · qalm', description: "This download isn't available yet.", path: '/download/unavailable', noindex: true }), main });
}

export { legalPages };
