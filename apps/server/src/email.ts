import type { Env } from './env';
import { escapeHtml } from './util';
import { BRAND_FONT_STACK, D, T } from './brand';

export interface EmailMessage { to: string; subject: string; text: string; html: string }

/** The sender is chosen by `EMAIL_PROVIDER`: `console` (dev: logs the message) or `resend`. */
export async function sendEmail(env: Env, msg: EmailMessage): Promise<void> {
  const provider = env.EMAIL_PROVIDER || 'console';
  if (provider === 'console') {
    console.log(`[email] to=${msg.to} subject=${JSON.stringify(msg.subject)}\n${msg.text}`);
    return;
  }
  if (provider === 'resend') {
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error('RESEND_API_KEY and EMAIL_FROM are required for EMAIL_PROVIDER=resend');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
    });
    if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
    return;
  }
  throw new Error(`Unknown EMAIL_PROVIDER: ${provider}`);
}

const MONO = `'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;

/**
 * The page around every qalm email, in qalm's brand (docs/brand.md: Figtree, indigo accent, solid tints, hairlines,
 * 8/12 px radii, no gradients): the lockup, a card with `title` and `rows`, and the footer. Clients that honour
 * `prefers-color-scheme` get the dark tokens.
 */
function shell(title: string, preview: string, rows: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(title)}</title>
<style>
@media (prefers-color-scheme: dark) {
  .q-bg { background:${D.bg} !important; }
  .q-card { background:${D.surface} !important; border-color:${D.line} !important; }
  .q-ink { color:${D.ink} !important; }
  .q-muted { color:${D.muted} !important; }
  .q-faint { color:${D.faint} !important; }
  .q-line2 { background:${D.line2} !important; }
  .q-code { background:${D.surface2} !important; border-color:${D.line} !important; color:${D.ink} !important; }
  .q-btn { background:${D.accent} !important; }
  .q-link { color:${D.accentInk} !important; }
}
</style></head>
<body class="q-bg" style="margin:0;padding:0;background:${T.bg};font-family:${BRAND_FONT_STACK};color:${T.ink};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="q-bg" style="background:${T.bg}"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="q-card" style="max-width:460px;background:${T.surface};border:1px solid ${T.line};border-radius:12px">
<tr><td style="padding:28px 28px 0">
<div class="q-ink" style="font-size:20px;line-height:22px;font-weight:600;letter-spacing:-0.02em;color:${T.ink}">qalm</div>
<div class="q-muted" style="font-size:12px;line-height:16px;font-weight:500;color:${T.muted}">by Apollo</div>
</td></tr>
<tr><td style="padding:24px 28px 0">
<h1 class="q-ink" style="margin:0 0 8px;font-size:24px;line-height:30px;font-weight:600;letter-spacing:-0.02em;color:${T.ink}">${escapeHtml(title)}</h1>
</td></tr>
${rows}
</table>
<p class="q-faint" style="margin:16px 0 0;font-size:12px;line-height:16px;color:${T.faint}">qalm by Apollo · <a href="https://apollolearn.app" class="q-faint" style="color:${T.faint};text-decoration:underline">apollolearn.app</a></p>
</td></tr></table></body></html>`;
}

const row = (html: string, top = 16, bottom = 0) => `<tr><td style="padding:${top}px 28px ${bottom}px">${html}</td></tr>`;
const para = (html: string) => `<p class="q-muted" style="margin:0;font-size:15px;line-height:22px;color:${T.muted}">${html}</p>`;
const small = (html: string, center = false) =>
  `<p class="q-faint" style="margin:0;font-size:12px;line-height:18px;color:${T.faint}${center ? ';text-align:center' : ''}">${html}</p>`;
const rule = () => row(`<div class="q-line2" style="height:1px;line-height:1px;font-size:1px;background:${T.line2}">&nbsp;</div>`, 24);
const codeBox = (code: string) =>
  `<div class="q-code" style="background:${T.surface2};border:1px solid ${T.line};border-radius:8px;padding:16px 12px;text-align:center;font-family:${MONO};font-size:32px;line-height:40px;font-weight:600;letter-spacing:0.3em;color:${T.ink}">${escapeHtml(code)}</div>`;

/**
 * The sign-in email. `code`: the 6-digit code for app sign-in, typed on the device that asked; the MCP consent email
 * has only the link.
 */
export function magicLinkEmail(to: string, link: string, code: string | null = null): EmailMessage {
  const l = escapeHtml(link);
  const preview = code ? `Your qalm sign-in code is ${code}. It works once and expires in 15 minutes.` : 'Your qalm sign-in link works once and expires in 15 minutes.';
  const intro = code
    ? 'Tap the button to sign in on this device, or type the code into qalm.'
    : 'Tap the button to sign in. The link works once and expires in 15 minutes.';
  const button = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="q-btn" align="center" style="background:${T.accent};border-radius:8px">
<a href="${l}" class="q-btn" style="display:block;padding:12px 20px;font-size:15px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;background:${T.accent}">Sign in to qalm</a>
</td></tr></table>`;
  const divider = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="height:1px;background:${T.line2}" class="q-line2"></td>
<td style="padding:0 12px;white-space:nowrap;font-size:12px;line-height:16px;color:${T.faint}" class="q-faint">or enter this code</td>
<td style="height:1px;background:${T.line2}" class="q-line2"></td>
</tr></table>`;
  const codeRows = code
    ? row(divider, 24) + row(codeBox(code)) + row(small('The link and the code each work once and expire in 15 minutes.', true), 10)
    : '';
  const ignore = `If you didn't ask to sign in to qalm, you can ignore this email. Nobody can sign in without this ${code ? 'link or code' : 'link'}.`;
  const html = shell(
    'Sign in to qalm',
    preview,
    row(para(intro), 0) +
      row(button, 20) +
      codeRows +
      row(small(`If the button doesn't work, paste this address into your browser:<br><a href="${l}" class="q-link" style="color:${T.accentInk};word-break:break-all;text-decoration:underline">${l}</a>`), 24) +
      rule() +
      row(small(ignore), 16, 24),
  );
  return {
    to,
    subject: code ? `Your qalm sign-in code: ${code}` : 'Your qalm sign-in link',
    text: [
      'Sign in to qalm',
      '',
      `Open this link to sign in:\n${link}`,
      ...(code ? ['', `Or enter this code in qalm: ${code}`] : []),
      '',
      `The link${code ? ' and the code each work' : ' works'} once and expire${code ? '' : 's'} in 15 minutes.`,
      ignore,
      '',
      'qalm by Apollo · https://apollolearn.app',
    ].join('\n'),
    html,
  };
}

/** The code that confirms deleting an account (Settings → Delete account). It never signs anyone in. */
export function accountDeletionEmail(to: string, code: string): EmailMessage {
  const what = 'your notebooks and pages, your handwriting and text, your PDFs and images, your AI connections, and the account itself';
  const ignore =
    "If you didn't ask to delete your qalm account, don't share this code with anyone. Your account stays as it is. If you don't recognise this, sign out of qalm on your devices.";
  const html = shell(
    'Delete your qalm account',
    `Your code to delete your qalm account is ${code}.`,
    row(para(`Enter this code in qalm to delete your account for good. This deletes ${what}. It can't be undone.`), 0) +
      row(codeBox(code), 20) +
      row(small("The code works once and expires in 15 minutes. It can't be used to sign in.", true), 10) +
      rule() +
      row(small(ignore), 16, 24),
  );
  return {
    to,
    subject: `Your code to delete your qalm account: ${code}`,
    text: [
      'Delete your qalm account',
      '',
      `Enter this code in qalm to delete your account for good: ${code}`,
      '',
      `This deletes ${what}. It can't be undone.`,
      "The code works once and expires in 15 minutes. It can't be used to sign in.",
      ignore,
      '',
      'qalm by Apollo · https://apollolearn.app',
    ].join('\n'),
    html,
  };
}
