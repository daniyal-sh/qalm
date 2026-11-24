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
 * The sign-in email, in qalm's brand (docs/brand.md: Figtree, indigo accent, solid tints, hairlines, 8/12 px radii,
 * no gradients). `code`: the 6-digit code for app sign-in, typed on the device that asked; the MCP consent email has
 * only the link. Email clients that honour `prefers-color-scheme` get the dark tokens.
 */
export function magicLinkEmail(to: string, link: string, code: string | null = null): EmailMessage {
  const l = escapeHtml(link);
  const c = code ? escapeHtml(code) : '';
  const preview = code ? `Your qalm sign-in code is ${c}. It works once and expires in 15 minutes.` : 'Your qalm sign-in link works once and expires in 15 minutes.';
  const intro = code
    ? 'Tap the button to sign in on this device, or type the code into qalm.'
    : 'Tap the button to sign in. The link works once and expires in 15 minutes.';
  const codeHtml = code
    ? `<tr><td style="padding:24px 28px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="height:1px;background:${T.line2}" class="q-line2"></td>
<td style="padding:0 12px;white-space:nowrap;font-size:12px;line-height:16px;color:${T.faint}" class="q-faint">or enter this code</td>
<td style="height:1px;background:${T.line2}" class="q-line2"></td>
</tr></table>
</td></tr>
<tr><td style="padding:16px 28px 0">
<div class="q-code" style="background:${T.surface2};border:1px solid ${T.line};border-radius:8px;padding:16px 12px;text-align:center;font-family:${MONO};font-size:32px;line-height:40px;font-weight:600;letter-spacing:0.3em;color:${T.ink}">${c}</div>
<p style="margin:10px 0 0;font-size:12px;line-height:18px;color:${T.faint};text-align:center" class="q-faint">The link and the code each work once and expire in 15 minutes.</p>
</td></tr>`
    : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>Sign in to qalm</title>
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
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${preview}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="q-bg" style="background:${T.bg}"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="q-card" style="max-width:460px;background:${T.surface};border:1px solid ${T.line};border-radius:12px">
<tr><td style="padding:28px 28px 0">
<div class="q-ink" style="font-size:20px;line-height:22px;font-weight:600;letter-spacing:-0.02em;color:${T.ink}">qalm</div>
<div class="q-muted" style="font-size:12px;line-height:16px;font-weight:500;color:${T.muted}">by Apollo</div>
</td></tr>
<tr><td style="padding:24px 28px 0">
<h1 class="q-ink" style="margin:0 0 8px;font-size:24px;line-height:30px;font-weight:600;letter-spacing:-0.02em;color:${T.ink}">Sign in to qalm</h1>
<p class="q-muted" style="margin:0;font-size:15px;line-height:22px;color:${T.muted}">${intro}</p>
</td></tr>
<tr><td style="padding:20px 28px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="q-btn" align="center" style="background:${T.accent};border-radius:8px">
<a href="${l}" class="q-btn" style="display:block;padding:12px 20px;font-size:15px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;background:${T.accent}">Sign in to qalm</a>
</td></tr></table>
</td></tr>
${codeHtml}
<tr><td style="padding:24px 28px 0">
<p class="q-faint" style="margin:0;font-size:12px;line-height:18px;color:${T.faint}">If the button doesn't work, paste this address into your browser:<br><a href="${l}" class="q-link" style="color:${T.accentInk};word-break:break-all;text-decoration:underline">${l}</a></p>
</td></tr>
<tr><td style="padding:24px 28px 0"><div class="q-line2" style="height:1px;line-height:1px;font-size:1px;background:${T.line2}">&nbsp;</div></td></tr>
<tr><td style="padding:16px 28px 24px">
<p class="q-faint" style="margin:0;font-size:12px;line-height:18px;color:${T.faint}">If you didn't ask to sign in to qalm, you can ignore this email. Nobody can sign in without this ${code ? 'link or code' : 'link'}.</p>
</td></tr>
</table>
<p class="q-faint" style="margin:16px 0 0;font-size:12px;line-height:16px;color:${T.faint}">qalm by Apollo · <a href="https://apollolearn.app" class="q-faint" style="color:${T.faint};text-decoration:underline">apollolearn.app</a></p>
</td></tr></table></body></html>`;
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
      `If you didn't ask to sign in to qalm, you can ignore this email. Nobody can sign in without this ${code ? 'link or code' : 'link'}.`,
      '',
      'qalm by Apollo · https://apollolearn.app',
    ].join('\n'),
    html,
  };
}
