import type { Env } from './env';
import { escapeHtml } from './util';
import { BRAND_FONT_STACK, T } from './brand';

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

/** `code`: the 6-digit fallback for app sign-in (typed on the device that asked). */
export function magicLinkEmail(to: string, link: string, code: string | null = null): EmailMessage {
  const l = escapeHtml(link);
  const codeHtml = code
    ? `<p style="margin:20px 0 0;font-size:13px;line-height:1.5;color:${T.muted}">Or enter this code in Qalm:</p>
<div style="margin:6px 0 0;font-size:26px;font-weight:600;letter-spacing:0.18em;font-family:ui-monospace,Menlo,Consolas,monospace">${escapeHtml(code)}</div>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;background:${T.bg};font-family:${BRAND_FONT_STACK};color:${T.ink}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${T.bg};padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:${T.surface};border:1px solid ${T.line};border-radius:12px">
<tr><td style="padding:28px 28px 8px">
<div style="font-size:18px;font-weight:600;letter-spacing:-0.02em">Qalm</div>
<div style="font-size:11px;font-weight:500;color:${T.muted}">by Apollo</div>
</td></tr>
<tr><td style="padding:16px 28px 4px">
<h1 style="margin:0 0 8px;font-size:20px;font-weight:600;letter-spacing:-0.02em">Sign in to Qalm</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:${T.muted}">Tap the button to sign in. The link works once and expires in 15 minutes.</p>
<a href="${l}" style="display:inline-block;background:${T.accent};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 20px;border-radius:8px">Sign in</a>
${codeHtml}
<p style="margin:20px 0 0;font-size:12px;line-height:1.5;color:${T.faint}">If the button doesn't work, paste this address into your browser:<br><span style="color:${T.accentInk};word-break:break-all">${l}</span></p>
</td></tr>
<tr><td style="padding:20px 28px 28px;font-size:12px;color:${T.faint}">If you didn't ask to sign in, you can ignore this email.</td></tr>
</table></td></tr></table></body></html>`;
  return {
    to,
    subject: 'Your Qalm sign-in link',
    text: `Sign in to Qalm:\n${link}\n${code ? `\nOr enter this code in Qalm: ${code}\n` : ''}\nThe link works once and expires in 15 minutes. If you didn't ask to sign in, ignore this email.`,
    html,
  };
}
