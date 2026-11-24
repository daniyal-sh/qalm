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

/** Plays the AI with the Tutor agent following, until the header reads "AI live · Tutor". */
async function aiLive(env) {
  const { page } = env;
  env.startAgent();
  const play = page.getByLabel(/AI paused\. Play AI/).first();
  if (await play.isVisible().catch(() => false)) await play.click();
  await page.getByText(/AI live · Tutor/).first().waitFor({ timeout: 20_000 });
}

/** Pauses the AI again and stops the agent, so the next shot starts paused. */
async function aiPause(env) {
  const { page } = env;
  const pause = page.getByLabel(/Pause AI$/).first();
  if (await pause.isVisible().catch(() => false)) await pause.click();
  await idle(page, 400);
  env.stopAgent();
}

/** Turns the open notebook's AI access on or off from the More menu (off hides comment pins, cards and the AI chip). */
async function aiAccess(env, on) {
  const { page } = env;
  await page.getByLabel('More', { exact: true }).first().click();
  const item = page.getByText(on ? 'Turn on AI access' : 'Turn off AI access', { exact: true }).first();
  if (await item.isVisible().catch(() => false)) await item.click();
  else await page.keyboard.press('Escape');
  await idle(page, 600);
}

/** Scrolls the page that fills most of the band [top, bottom] (CSS px) to the band's middle. */
async function centreBetween(env, top, bottom) {
  const { page } = env;
  const r = await page.evaluate(([top, bottom]) => {
    const rs = [...document.querySelectorAll('canvas')].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 200 && r.height > 150);
    const seen = (r) => Math.max(0, Math.min(r.bottom, bottom) - Math.max(r.top, top));
    rs.sort((a, b) => seen(b) - seen(a));
    return rs[0] ? { top: rs[0].top, h: rs[0].height } : null;
  }, [top, bottom]);
  if (!r) return;
  const want = top + Math.max(8, (bottom - top - r.h) / 2);
  await page.mouse.move(env.w / 2, (top + bottom) / 2);
  await page.mouse.wheel(0, r.top - want);
  await idle(page, 900);
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
    // An imported PDF slide annotated by hand: a circled formula, arrows, a highlight, margin notes; AI live with the
    // Tutor following. The slide has no comment threads (no pins on it).
    name: 'pdf',
    settle: 1200,
    async run(env) {
      await open(env, 'calc', 2);
      await aiLive(env);
      await env.page.mouse.move(env.w - 2, env.h - 2);
    },
    async after(env) {
      await aiPause(env);
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
    // Markdown + LaTeX text box on the last slide, scrolled to the end. AI access off, so the slide above shows no
    // comment pins or margin cards.
    name: 'markdown',
    async run(env) {
      const { page } = env;
      await open(env, 'calc', 5, false);
      await aiAccess(env, false);
      await page.mouse.move(env.w / 2, env.h / 2);
      await page.mouse.wheel(0, 4000);
      await idle(page, 1200);
      await page.mouse.move(env.w - 2, env.h - 2);
    },
    async after(env) {
      await aiAccess(env, true);
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
      await aiLive(env);
      await page.getByLabel(/^Comments/).first().click();
      await idle(page, 1200);
      const t = page.getByText(/Why is there only one \+C/).first();
      if (await t.isVisible().catch(() => false)) await t.click();
      // MathJax loads on demand: until it has, a formula shows its TeX source as text
      await page.waitForFunction(() => !/C_1|\\int|\\sin/.test(document.body.innerText), null, { timeout: 20_000 });
      await idle(page, 1200);
      await page.mouse.move(env.w - 2, env.h - 2);
    },
    async after(env) {
      await aiPause(env);
    },
  },
  {
    // Lecture: playback of the recorded lecture at 18:01, on the LIATE slide (no comment threads) with the mnemonic
    // being written, the transcript following along, and the slide centred between the header and the player. AI access
    // is off for it (as a student replaying a lecture may have it), so no comment pins show on the slides around it.
    name: 'lecture',
    settle: 1500,
    async run(env) {
      const { page } = env;
      await open(env, 'calc', 3, false);
      await aiAccess(env, false);
      await page.getByLabel('More', { exact: true }).first().click();
      await page.getByText(/^Lectures \(1\)/).first().click();
      await page.locator('[data-testid="lecture-play-0"]').first().click();
      await page.getByLabel('Position').first().waitFor({ timeout: 15_000 });
      await idle(page, 800);
      const pos = await page.getByLabel('Position').first().boundingBox();
      // seek to 18:01 (the mnemonic mostly written): click, read where it landed, correct
      const want = 18 * 60 + 1, dur = 49 * 60 + 37;
      let x = pos.x + (pos.width * want) / dur;
      for (let k = 0; k < 4; k++) {
        await page.mouse.click(x, pos.y + pos.height / 2);
        await idle(page, 500);
        const [m, s] = ((await page.locator('[data-testid="lecture-position"]').first().innerText()).split('/')[0] ?? '').trim().split(':').map(Number);
        const err = m * 60 + s - want;
        if (Math.abs(err) <= 2 || Number.isNaN(err)) break;
        x -= (err / dur) * pos.width;
      }
      await idle(page, 1000);
      const tr = page.getByLabel('Transcript', { exact: true }).first();
      if ((await tr.getAttribute('aria-selected').catch(() => null)) !== 'true' && !(await page.getByText(/Whichever type comes first/).first().isVisible().catch(() => false))) await tr.click();
      await idle(page, 1200);
      // the transcript starts on a whole line: the one before the current line at the top of its panel
      const cur = await page.getByText(/Whichever type comes first/).first().elementHandle();
      await cur?.evaluate((el) => {
        let sc = el.parentElement;
        while (sc && !(sc.scrollHeight > sc.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
        if (!sc) return;
        let row = el;
        while (row.parentElement && row.parentElement.parentElement !== sc) row = row.parentElement;
        const prev = row.previousElementSibling ?? row;
        sc.scrollTop += prev.getBoundingClientRect().top - sc.getBoundingClientRect().top - 6;
      });
      await idle(page, 400);
      const bar = await page.locator('[data-testid="lecture-player"]').first().boundingBox();
      await centreBetween(env, 82, bar ? bar.y - 8 : env.h - 80);
      await page.mouse.move(env.w - 2, env.h - 2);
    },
    async after(env) {
      await env.page.getByLabel('Close player').first().click().catch(() => {});
      await idle(env.page, 400);
      await aiAccess(env, true);
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
      // Circling the product rule (slide units) in about half a second: the trail fades over 1 s, so all of it is still
      // on screen, fading from its start, when the shot is taken with the pointer still down.
      const [cx, cy, rx, ry] = [146, 158, 112, 34];
      await page.mouse.move(b.x + (cx - rx) * s, b.y + (cy + 6) * s);
      await page.mouse.down();
      for (let i = 1; i <= 30; i++) {
        const a = Math.PI + 0.18 + (i / 30) * Math.PI * 1.8;
        await page.mouse.move(b.x + (cx + rx * Math.cos(a)) * s, b.y + (cy - ry * Math.sin(a) * (1 - 0.06 * (i / 30))) * s);
        await page.waitForTimeout(14);
      }
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
