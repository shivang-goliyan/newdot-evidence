/**
 * Reconnaissance for the #95808 seed. Costs one CI run and answers everything the seed needs to
 * know, so the seed itself is not written against guessed selectors:
 *
 *   - does the account already have a workspace?          (settings/workspaces)
 *   - does it already have an expense report to rename?   (search?q=type:expense-report)
 *   - what are the FAB menu items ACTUALLY called?        (the labels the seed must click)
 *
 * Everything is logged AND screenshotted: a name printed to the log can be pasted into a selector,
 * and the screenshot proves the page was really in the state the log claims.
 *
 * Env: APP_URL, EXPENSIFY_EMAIL, OUT_DIR.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const APP_URL = process.env.APP_URL ?? "https://dev.new.expensify.com:8082";
const EMAIL = process.env.EXPENSIFY_EMAIL;
const OUT_DIR = process.env.OUT_DIR ?? "screenshots";

if (!EMAIL) {
  throw new Error("EXPENSIFY_EMAIL is not set");
}
mkdirSync(OUT_DIR, { recursive: true });

const shoot = (page, name) =>
  page.screenshot({ path: path.join(OUT_DIR, `probe-${name}.png`) });

/** Every clickable/labelled thing currently on screen, deduped — the raw material for a selector. */
async function visibleNames(page) {
  return page.evaluate(() => {
    const out = new Set();
    for (const el of document.querySelectorAll(
      '[role="button"],[role="menuitem"],[role="link"],button,[aria-label]',
    )) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const name = el.getAttribute("aria-label") || el.textContent?.trim();
      if (name && name.length < 60) out.add(name);
    }
    return [...out];
  });
}

function fetchMagicCode(since) {
  const script = path.join(import.meta.dirname, "magic_code.py");
  return execFileSync(
    "python3",
    [script, "--since", String(since), "--timeout", "180"],
    { encoding: "utf8" },
  ).trim();
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1512, height: 982 },
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();

try {
  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
  const emailField = page.getByRole("textbox").first();
  await emailField.waitFor({ state: "visible", timeout: 120_000 });
  await emailField.fill(EMAIL);
  const requestedAt = Date.now() / 1000;
  await page.keyboard.press("Enter");
  const code = fetchMagicCode(requestedAt);
  await page.waitForTimeout(2_000);
  await page.keyboard.type(code, { delay: 120 });
  await page.waitForSelector('[data-testid="BaseSidebarScreen"]', {
    timeout: 120_000,
  });
  console.log("=== signed in ===");
  await page.waitForTimeout(5_000);
  await shoot(page, "1-inbox");

  // 1. What does the FAB offer, and what is each item called?
  const fab = page
    .getByRole("button", { name: /create|new|start chat|\+/i })
    .last();
  await fab.click({ timeout: 20_000 }).catch((e) => console.log(`FAB click failed: ${e.message}`));
  await page.waitForTimeout(2_500);
  await shoot(page, "2-fab-open");
  console.log("=== FAB MENU ITEMS ===");
  console.log(JSON.stringify(await visibleNames(page), null, 1));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1_500);

  // 2. Does a workspace already exist?
  await page.goto(`${APP_URL}/settings/workspaces`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(6_000);
  await shoot(page, "3-workspaces");
  console.log("=== WORKSPACES PAGE ===");
  console.log(JSON.stringify(await visibleNames(page), null, 1));

  // 3. Does an expense report already exist? If one does, the seed is just a rename.
  await page.goto(
    `${APP_URL}/search?q=${encodeURIComponent("type:expense-report")}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForTimeout(10_000);
  await shoot(page, "4-expense-reports");
  console.log("=== EXPENSE REPORT LIST ===");
  console.log(JSON.stringify(await visibleNames(page), null, 1));
} catch (error) {
  await shoot(page, "failure").catch(() => {});
  throw error;
} finally {
  await context.close();
  await browser.close();
}
