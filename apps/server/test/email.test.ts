import { describe, expect, it } from 'vitest';
import { magicLinkEmail } from '../src/email';

describe('sign-in email', () => {
  const link = 'https://qalm.example/app/auth/email/verify?token=abc&x=<1>';

  it('shows the link and the 6-digit code, escaped, in light and dark', () => {
    const m = magicLinkEmail('ada@example.com', link, '042917');
    expect(m.to).toBe('ada@example.com');
    expect(m.subject).toBe('Your qalm sign-in code: 042917');
    expect(m.html).toContain('href="https://qalm.example/app/auth/email/verify?token=abc&#38;x=&#60;1&#62;"');
    expect(m.html).not.toContain('<1>');
    expect(m.html).toContain('>042917</div>');
    expect(m.html).toContain('or enter this code');
    expect(m.html).toContain('prefers-color-scheme: dark');
    expect(m.html).not.toMatch(/gradient|blur/i);
    expect(m.html).toContain('qalm');
    expect(m.text).toContain(link);
    expect(m.text).toContain('Or enter this code in qalm: 042917');
  });

  it('has only the link for the MCP consent page', () => {
    const m = magicLinkEmail('ada@example.com', link);
    expect(m.subject).toBe('Your qalm sign-in link');
    expect(m.html).not.toContain('or enter this code');
    expect(m.text).not.toMatch(/code/i);
  });
});
