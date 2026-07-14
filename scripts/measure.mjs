/**
 * Measure real DOM geometry in a running NewDot build.
 *
 * WHY THIS EXISTS. Our investigations DERIVE the numbers a fix turns on — "the receipt thumbnail
 * sits 456px from the viewport edge, so a 380px preview fits to its left". Deriving is fragile in
 * one specific way: you drop a term. On Expensify/App#95975 the whole thread came down to that one
 * number, two camps asserted contradictory values (340 vs 456), and the 340 was 320+20 with the
 * 72px nav rail simply forgotten — by someone who had cited the 72px constant three paragraphs
 * earlier. No amount of re-reading catches that. Measuring does, instantly.
 *
 * So this does not try to "reproduce a visual bug", which is open-ended and unreliable. It does the
 * narrow mechanical thing that actually settles arguments: sign in, go to a route, and return
 * getBoundingClientRect() for a set of selectors. A measured number beats a derived one, and a
 * measured number that DISAGREES with the derived one is itself the finding — it means a term was
 * dropped, and that is precisely the class of error that loses issues.
 *
 * Env:
 *   APP_URL          dev server (default https://dev.new.expensify.com:8082)
 *   EXPENSIFY_EMAIL  account to sign in as
 *   ROUTE            route to open after sign-in, e.g. "/search?q=type:expense"
 *   SELECTORS        JSON array of {name, selector} — CSS or testid=<id> or text=<...>
 *   VIEWPORTS        JSON array of [w,h] pairs (default [[1600,982]])
 *   SETTLE_MS        ms to wait after navigation before measuring (default 4000)
 *   LABEL            names hover screenshots, e.g. "before" / "after" (default "measure")
 *   OUT_DIR          where measurements.json + screenshots land (default screenshots)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const APP_URL = process.env.APP_URL ?? "https://dev.new.expensify.com:8082";
const EMAIL = process.env.EXPENSIFY_EMAIL;
const ROUTE = process.env.ROUTE ?? "/";
const OUT_DIR = process.env.OUT_DIR ?? "screenshots";
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 4000);
// Names the hover screenshots, so a before/after pair from two refs does not overwrite itself.
const LABEL = process.env.LABEL ?? "measure";
const SELECTORS = JSON.parse(process.env.SELECTORS ?? "[]");
const VIEWPORTS = JSON.parse(process.env.VIEWPORTS ?? "[[1600,982]]");

if (!EMAIL) throw new Error("EXPENSIFY_EMAIL is not set");
if (!SELECTORS.length) throw new Error("SELECTORS is empty — nothing to measure");
mkdirSync(OUT_DIR, { recursive: true });

/** testid=x and text=x are Playwright-native; anything else is treated as a raw CSS selector. */
const resolve = (page, sel) => {
  if (sel.startsWith("testid=")) return page.getByTestId(sel.slice(7));
  if (sel.startsWith("text=")) return page.getByText(new RegExp(sel.slice(5), "i"));
  return page.locator(sel);
};

/**
 * Everything on this page that can actually be addressed.
 *
 * A run takes ~15 minutes (npm ci + dev server + sign-in). Coming back with "your selector matched
 * nothing" and no further information would burn all of that and teach us nothing — and the caller
 * CANNOT know the right selector in advance, because plenty of components carry no testID at all
 * (ReceiptCell is one). So every run also dumps the addressable surface of the page: the model that
 * wrote a failing selector gets handed the real list and its next attempt is a lookup, not a guess.
 *
 * Costs a few hundred ms. Always worth it.
 */
const discover = (page) =>
  page.evaluate(() => {
    const ids = [...new Set([...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid")))];
    // For each testid, a compact sketch of its subtree, so a caller can build a CSS path down to a
    // child that has no testid of its own (the common case for leaf cells).
    const outline = ids.slice(0, 120).map((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      const r = el?.getBoundingClientRect();
      const kids = [...(el?.children ?? [])]
        .slice(0, 6)
        .map((c, i) => `${c.tagName.toLowerCase()}:nth-child(${i + 1})${c.getAttribute("data-testid") ? `[testid=${c.getAttribute("data-testid")}]` : ""}`);
      return {
        testid: id,
        rect: r && { left: Math.round(r.x), top: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        children: kids,
      };
    });
    return { count: ids.length, outline };
  });

function fetchMagicCode(since, timeoutS = 180) {
  const script = path.join(import.meta.dirname, "magic_code.py");
  return execFileSync("python3", [script, "--since", String(since), "--timeout", String(timeoutS)], {
    encoding: "utf8",
  }).trim();
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: VIEWPORTS[0][0], height: VIEWPORTS[0][1] },
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();
const results = [];

/**
 * Sign in, retrying the magic-code REQUEST rather than giving up on the first one.
 *
 * The code is a single email. If it is throttled (Expensify rate-limits repeated requests to the
 * same address, which we hit after several runs in an hour) or merely slow, a one-shot request
 * throws away the whole ~13-minute run — we have already paid npm ci, the dev server and Playwright
 * by this point. Ask again, wait longer each time. Cheap insurance against the one step that is
 * outside our control.
 */
async function signIn() {
  const waits = [180, 240, 300]; // seconds to wait for the code, per attempt
  for (let i = 0; i < waits.length; i++) {
    await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
    const emailField = page.getByRole("textbox").first();
    await emailField.waitFor({ state: "visible", timeout: 120_000 });
    await emailField.fill(EMAIL);
    const requestedAt = Date.now() / 1000;
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2_000);

    let code;
    try {
      code = fetchMagicCode(requestedAt, waits[i]);
    } catch {
      const backoff = 60 * (i + 1);
      console.log(`no magic code within ${waits[i]}s (attempt ${i + 1}/${waits.length}) — ` +
        `likely throttled; backing off ${backoff}s and requesting a fresh one`);
      await page.waitForTimeout(backoff * 1000);
      continue;
    }
    await page.keyboard.type(code, { delay: 120 });
    await page.waitForSelector('[data-testid="BaseSidebarScreen"]', { timeout: 120_000 });
    console.log(`signed in (attempt ${i + 1})`);
    return;
  }
  throw new Error(
    "could not sign in: no magic code after 3 requests. The account is almost certainly being " +
    "rate-limited for magic codes — space the runs further apart.",
  );
}

try {
  await signIn();

  // Measure at EVERY requested viewport. A fix that turns on a threshold usually only flips at some
  // widths, so a single-width measurement can miss the case that actually matters.
  let discovery = null;
  let missed = 0;
  for (const [width, height] of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    await page.goto(`${APP_URL}${ROUTE}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForTimeout(SETTLE_MS);
    discovery ??= await discover(page);

    for (const { name, selector, hover, hoverWaitMs } of SELECTORS) {
      // Some elements only EXIST while something else is hovered — a tooltip, a popover, or (the
      // case this was built for) a receipt hover-preview. Measuring the thing the bug is actually
      // about therefore requires driving the pointer first, so a selector may name an element to
      // hover before it is looked for.
      if (hover) {
        const h = resolve(page, hover).first();
        if (await h.isVisible().catch(() => false)) {
          await h.hover();
          // The preview debounces (CONST.TIMING.SHOW_HOVER_PREVIEW_DELAY) and then fades in, and it
          // re-positions once its own height is measured. Measuring before that settles reads the
          // first-frame fallback position, not the final one.
          await page.waitForTimeout(hoverWaitMs ?? 2500);
        } else {
          console.log(`[${width}x${height}] ${name}: hover target "${hover}" not found`);
        }
      }

      // A selector may be given as a fallback chain — the first one that resolves wins. Cheap
      // insurance: the caller often cannot know whether a component carries a testID.
      const chain = Array.isArray(selector) ? selector : [selector];
      const entry = { viewport: `${width}x${height}`, name, hovered: hover ?? null };
      let box = null;
      for (const sel of chain) {
        const loc = resolve(page, sel).first();
        if (await loc.isVisible().catch(() => false)) {
          box = await loc.boundingBox();
          entry.selector = sel;
          break;
        }
      }
      if (!box) {
        // NOT necessarily an error. "This element does not render on this surface" is frequently
        // the whole finding — an early return or a layout guard making a surface unreachable is as
        // valuable as a number. But it can ALSO just be a bad selector, and we cannot tell the two
        // apart from here. So we say so honestly and let the discovery dump settle it.
        entry.rendered = false;
        entry.tried = chain;
        missed++;
        results.push(entry);
        console.log(`[${width}x${height}] ${name}: NOT RENDERED (tried ${chain.join(" | ")})`);
        continue;
      }
      Object.assign(entry, {
        rendered: true,
        left: Math.round(box.x),
        top: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      });
      results.push(entry);
      console.log(`[${width}x${height}] ${name}: left=${entry.left} top=${entry.top} w=${entry.width} h=${entry.height}`);
      // Photograph a hover-only element WHILE it is still up — the pointer moves on the next
      // iteration and it vanishes. A number proves the position; the picture proves the number is
      // describing the thing everyone is arguing about.
      if (hover) {
        await page.screenshot({ path: path.join(OUT_DIR, `${LABEL}-${name}-${width}x${height}.png`) });
      }
    }
    await page.screenshot({ path: path.join(OUT_DIR, `measure-${width}x${height}.png`), fullPage: false });
  }

  writeFileSync(
    path.join(OUT_DIR, "measurements.json"),
    JSON.stringify({ route: ROUTE, results, discovery }, null, 2),
  );

  // Print the addressable surface whenever anything failed to resolve. This is what makes a failed
  // run cheap: the next attempt is a lookup in this list rather than another guess.
  if (missed) {
    console.log(`\n${missed} selector(s) did not resolve. Addressable elements on this route:`);
    for (const o of discovery?.outline ?? []) {
      const r = o.rect ? `left=${o.rect.left} top=${o.rect.top} ${o.rect.w}x${o.rect.h}` : "(no box)";
      console.log(`  testid=${o.testid}  ${r}`);
      if (o.children?.length) console.log(`      children: ${o.children.join(", ")}`);
    }
    if (!discovery?.count) {
      console.log("  (none — the route rendered no testids at all: wrong route, or the account has no data here)");
    }
  }
  console.log(`\nwrote ${results.length} measurements (${discovery?.count ?? 0} testids on the page)`);
} catch (error) {
  await page.screenshot({ path: path.join(OUT_DIR, "measure-failure.png") }).catch(() => {});
  throw error;
} finally {
  await context.close();
  await browser.close();
}
