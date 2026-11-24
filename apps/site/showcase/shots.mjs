// The showcase shots: each drives the app into one state. `run` gets { page, origin, nb, size, theme, w, h, ... }.
// The shot runs, then the page is screenshotted; `after` (optional) undoes anything that would leak into the next one.

const idle = (page, ms = 600) => page.waitForTimeout(ms);

/** Waits until the editor shows its pages (and the canvases have painted). */
async function editorReady(page) {
  await page.getByLabel('Back to library').first().waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll('canvas').length > 0, null, { timeout: 30_000 });
  await idle(page, 1800);
}

/** Opens a notebook at page `n` (1-based), fresh: no panels, no selection. `lift` centres the page under the toolbar. */
export async function open(env, key, n = 1, lift = true) {
  const { page, origin, nb } = env;
  await page.goto(`${origin}/notebook/${nb[key].id}`);
  await editorReady(page);
  if (n > 1) {
    await page.keyboard.press('Control+g');
    const input = page.getByLabel(/^Page number, 1 to/).first();
    await input.fill(String(n));
    await input.press('Enter');
    await idle(page, 1200);
  }
  if (lift) await centre(env);
  await page.mouse.move(env.w - 2, env.h - 2);
}

/** The box (CSS px) of the page whose canvas is nearest the middle of the window. */
async function pageBox(page) {
  return page.evaluate(() => {
    const rs = [...document.querySelectorAll('canvas')].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 200 && r.height > 200);
    const mid = innerHeight / 2;
    rs.sort((a, b) => Math.abs((a.top + a.bottom) / 2 - mid) - Math.abs((b.top + b.bottom) / 2 - mid));
    const r = rs[0];
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
}

/** Scrolls so the page that go-to brought to the top sits in the middle of the space under the floating toolbar. */
async function centre(env) {
  const { page } = env;
  const r = await page.evaluate(() => {
    const rs = [...document.querySelectorAll('canvas')].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 200 && r.height > 150 && r.bottom > 60);
    rs.sort((a, b) => Math.abs(a.top - 90) - Math.abs(b.top - 90));
    return rs[0] ? { top: rs[0].top, h: rs[0].height } : null;
  });
  if (!r) return;
  const top = 82 + 88; // header + toolbar
  const want = top + Math.max(12, (env.h - top - r.h) / 2);
  await page.mouse.move(env.w / 2, env.h / 2);
  await page.mouse.wheel(0, r.top - want);
  await idle(page, 900);
}

/** A mouse stroke through `pts` (CSS px), in small steps, like a hand. */
async function drag(page, pts, { steps = 6, hold = false } = {}) {
  await page.mouse.move(...pts[0]);
  await page.mouse.down();
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    for (let k = 1; k <= steps; k++) await page.mouse.move(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps);
  }
  if (!hold) await page.mouse.up();
}

export const SHOTS = [
  {
    name: 'library',
    async run({ page, origin, w }) {
      await page.goto(`${origin}/`);
      await page.getByText('Calculus II · Lecture 7').first().waitFor({ timeout: 30_000 });
      await idle(page, 1200);
      await page.mouse.move(w - 2, 2);
    },
  },
  {
    // An imported PDF slide annotated by hand: a circled formula, arrows, a highlight, margin notes, the tutor's card.
    name: 'pdf',
    async run(env) {
      await open(env, 'calc', 2);
    },
  },
  {
    // An embedded image labelled with ink and snapped arrows, a boxed key idea.
    name: 'image',
    async run(env) {
      await open(env, 'bio', 1, false);
    },
  },
  {
    // Markdown + LaTeX text box on a slide.
    name: 'markdown',
    async run(env) {
      await open(env, 'calc', 5);
    },
  },
  {
    // The planner: highlighter stickies and a Markdown checklist.
    name: 'planner',
    async run(env) {
      await open(env, 'plan', 1, false);
    },
  },
  {
    // Lasso: a rectangle over the être verbs, with the selection frame, handles and the selection bar.
    name: 'lasso',
    async run(env) {
      const { page } = env;
      await open(env, 'french', 1, false);
      await page.keyboard.press('l');
      await idle(page, 300);
      const rect = page.getByLabel('Rectangle select').first();
      if (await rect.isVisible().catch(() => false)) await rect.click();
      await idle(page, 300);
      const b = await pageBox(page);
      const s = b.w / 595;
      const y0 = b.y + (72 + 24 * 8 - 16) * s;
      const y1 = b.y + (72 + 24 * 12 + 2) * s;
      await drag(page, [[b.x + 40 * s, y0], [b.x + 560 * s, y1]], { steps: 12 });
      await idle(page, 600);
      await page.mouse.move(env.w - 2, env.h - 2);
    },
    async after({ page }) {
      await page.keyboard.press('Escape');
      await page.keyboard.press('p');
    },
  },
  {
    // The page navigator with slide thumbnails.
    name: 'navigator',
    async run(env) {
      const { page } = env;
      await open(env, 'calc', 2);
      await page.getByLabel('Pages', { exact: true }).first().click();
      await idle(page, 2500);
      await page.mouse.move(env.w - 2, env.h - 2);
    },
  },
  {
    // The pen's colour picker open over the cell diagram.
    name: 'colours',
    async run(env) {
      const { page } = env;
      await open(env, 'bio', 1, false);
      await page.keyboard.press('p');
      const add = page.getByLabel(/more colours|Add a colour/).first();
      await add.click();
      await idle(page, 900);
    },
    async after({ page }) {
      await page.keyboard.press('Escape');
    },
  },
  {
    // AI: "AI live · Tutor" in the header, the comments panel with the tutor's Markdown reply.
    name: 'ai',
    settle: 1500,
    async run(env) {
      const { page } = env;
      await open(env, 'calc', 4);
      env.startAgent();
      await page.getByLabel(/AI paused\. Play AI/).first().click();
      await page.getByText(/AI live · Tutor/).first().waitFor({ timeout: 20_000 });
      await page.getByLabel(/^Comments/).first().click();
      await idle(page, 1200);
      const t = page.getByText(/Why is there only one \+C/).first();
      if (await t.isVisible().catch(() => false)) await t.click();
      await idle(page, 1200);
      await page.mouse.move(env.w - 2, env.h - 2);
    },
    async after(env) {
      env.stopAgent();
    },
  },
  {
    // Lecture: playback of the recorded lecture, mid-way, with the transcript following along.
    name: 'lecture',
    settle: 1500,
    async run(env) {
      const { page } = env;
      await open(env, 'calc', 4);
      await page.getByLabel('More', { exact: true }).first().click();
      await page.getByText(/^Lectures \(1\)/).first().click();
      await page.locator('[data-testid="lecture-play-0"]').first().click();
      await page.getByLabel('Position').first().waitFor({ timeout: 15_000 });
      await idle(page, 800);
      const pos = await page.getByLabel('Position').first().boundingBox();
      await page.mouse.click(pos.x + pos.width * (29.4 / 49.6), pos.y + pos.height / 2);
      await idle(page, 1000);
      const tr = page.getByLabel('Transcript', { exact: true }).first();
      if ((await tr.getAttribute('aria-selected').catch(() => null)) !== 'true' && !(await page.getByText(/factor it: e to the x/).first().isVisible().catch(() => false))) await tr.click();
      await idle(page, 1200);
      await page.mouse.move(env.w - 2, env.h - 2);
    },
    async after({ page }) {
      await page.getByLabel('Close player').first().click().catch(() => {});
    },
  },
  {
    // The ruler turned to the refracted ray, which was just drawn along its edge.
    name: 'ruler',
    async run(env) {
      const { page } = env;
      await open(env, 'physics', 1, false);
      await page.mouse.move(env.w / 2, env.h / 2);
      await page.mouse.wheel(0, env.h > env.w ? 120 : 260); // the diagram in the middle
      await idle(page, 900);
      await page.keyboard.press('p');
      await page.keyboard.press('r');
      const ruler = page.getByLabel(/^Ruler, \d+°$/).first();
      await ruler.waitFor({ timeout: 10_000 });
      const b = await pageBox(page);
      const s = b.w / 595;
      const P = [b.x + 300 * s, b.y + 380 * s]; // where the ray meets the glass
      const phi = (67.5 * Math.PI) / 180; // the refracted ray, 22.5° from the normal
      const u = [Math.cos(phi), Math.sin(phi)];
      const rb = await ruler.boundingBox();
      const c0 = [rb.x + rb.width / 2, rb.y + rb.height / 2];
      const th = rb.height;
      // turn by the handle (it sits at the right end), around the centre
      const hb = await page.getByLabel('Turn ruler').first().boundingBox();
      const hc = [hb.x + hb.width / 2, hb.y + hb.height / 2];
      const reach = Math.hypot(hc[0] - c0[0], hc[1] - c0[1]);
      const a0 = Math.atan2(hc[1] - c0[1], hc[0] - c0[0]);
      const arc = [];
      for (let i = 0; i <= 24; i++) {
        const a = a0 + (phi * i) / 24;
        arc.push([c0[0] + reach * Math.cos(a), c0[1] + reach * Math.sin(a)]);
      }
      await drag(page, arc, { steps: 2 });
      await idle(page, 500);
      // the top edge's normal after turning, and a point on that edge
      const n = [Math.sin(phi), -Math.cos(phi)];
      // slide it so that edge passes through P, with the ruler running on down along the ray
      const target = [P[0] + u[0] * reach * 0.8 + (n[0] * th) / 2 + n[0] * 1.5, P[1] + u[1] * reach * 0.8 + (n[1] * th) / 2 + n[1] * 1.5];
      const shift = [target[0] - c0[0], target[1] - c0[1]];
      const grab = [c0[0] - u[0] * reach * 0.45, c0[1] - u[1] * reach * 0.45]; // on the body, away from the readout
      await drag(page, [grab, [grab[0] + shift[0], grab[1] + shift[1]]], { steps: 10 });
      await idle(page, 500);
      // draw the refracted ray along the edge, a slightly wobbly hand
      const start = [P[0] - n[0] * 5, P[1] - n[1] * 5]; // just outside the edge (the body is on the +n side)
      const len = 170 * s;
      const pts = [];
      for (let i = 0; i <= 20; i++) pts.push([start[0] + u[0] * len * (i / 20) - n[0] * Math.abs(Math.sin(i / 2)) * 3, start[1] + u[1] * len * (i / 20) - n[1] * Math.abs(Math.sin(i / 2)) * 3]);
      await drag(page, pts, { steps: 3 });
      await idle(page, 800);
      await page.mouse.move(env.w - 2, env.h - 2);
    },
    async after({ page }) {
      await page.keyboard.press('Control+z');
      await page.keyboard.press('r');
    },
  },
  {
    // Presenting (F5) the lecture slides with the laser: captured mid-stroke so the trail reads as one sweep.
    name: 'present',
    settle: 0,
    async run(env) {
      const { page } = env;
      await open(env, 'calc', 2);
      await page.keyboard.press('F5');
      await idle(page, 1500);
      await page.keyboard.press('k');
      await idle(page, 300);
      const trail = page.getByLabel(/trail/i).first();
      if (await trail.isVisible().catch(() => false)) await trail.click();
      const b = await pageBox(page);
      const s = b.w / SLIDE_W;
      // a sweep under the product rule, then up towards u'v + uv', still moving when the shot is taken
      const pts = [];
      for (let i = 0; i <= 70; i++) {
        const t = i / 70;
        pts.push([b.x + (60 + 190 * t) * s, b.y + (180 + 6 * Math.sin(t * Math.PI) - (t > 0.8 ? (t - 0.8) * 60 : 0)) * s]);
      }
      await drag(page, pts, { steps: 2, hold: true });
    },
    async after({ page }) {
      await page.mouse.up();
      await page.keyboard.press('Escape');
      await page.keyboard.press('p');
    },
  },
  {
    // Fullscreen focus: no header or toolbar, the floating pill.
    name: 'focus',
    async run(env) {
      const { page } = env;
      await open(env, 'french', 1, false);
      await page.getByLabel(/^Full screen/).first().click();
      await idle(page, 1500);
      await page.mouse.move(env.w - 2, env.h - 2);
    },
    async after({ page }) {
      await page.keyboard.press('Escape');
    },
  },
];

const SLIDE_W = 768;
