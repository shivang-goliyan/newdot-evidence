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

function fetchMagicCode(since) {
  const script = path.join(import.meta.dirname, "magic_code.py");
  return execFileSync("python3", [script, "--since", String(since), "--timeout", "180"], {
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

try {
  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
  const emailField = page.getByRole("textbox").first();
  await emailField.waitFor({ state: "visible", timeout: 120_000 });
  await emailField.fill(EMAIL);
  const requestedAt = Date.now() / 1000;
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2_000);
  await page.keyboard.type(fetchMagicCode(requestedAt), { delay: 120 });
  await page.waitForSelector('[data-testid="BaseSidebarScreen"]', { timeout: 120_000 });
  console.log("signed in");

  // Measure at EVERY requested viewport. A fix that turns on a threshold usually only flips at some
  // widths, so a single-width measurement can miss the case that actually matters.
  for (const [width, height] of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    await page.goto(`${APP_URL}${ROUTE}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForTimeout(SETTLE_MS);

    for (const { name, selector } of SELECTORS) {
      const loc = resolve(page, selector).first();
      const entry = { viewport: `${width}x${height}`, name, selector };
      if (!(await loc.isVisible().catch(() => false))) {
        // NOT an error. "This element does not render on this surface" is frequently the whole
        // finding — an early return or a layout guard can make a surface unreachable, and proving
        // that is as valuable as a number.
        entry.rendered = false;
        results.push(entry);
        console.log(`[${width}x${height}] ${name}: NOT RENDERED`);
        continue;
      }
      const box = await loc.boundingBox();
      Object.assign(entry, {
        rendered: true,
        left: box && Math.round(box.x),
        top: box && Math.round(box.y),
        width: box && Math.round(box.width),
        height: box && Math.round(box.height),
      });
      results.push(entry);
      console.log(`[${width}x${height}] ${name}: left=${entry.left} top=${entry.top} w=${entry.width} h=${entry.height}`);
    }
    await page.screenshot({ path: path.join(OUT_DIR, `measure-${width}x${height}.png`) });
  }

  writeFileSync(path.join(OUT_DIR, "measurements.json"), JSON.stringify({ route: ROUTE, results }, null, 2));
  console.log(`\nwrote ${results.length} measurements`);
} catch (error) {
  await page.screenshot({ path: path.join(OUT_DIR, "measure-failure.png") }).catch(() => {});
  throw error;
} finally {
  await context.close();
  await browser.close();
}
