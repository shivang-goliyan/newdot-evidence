/**
 * Seed for #95808: rename an existing expense report to a title containing HTML entities.
 *
 * The probe showed the account already owns expense reports ("Expense Report 2026-03-17"), so the
 * seed is a rename — no workspace/expense creation, and therefore nothing that can half-succeed and
 * leave junk behind.
 *
 * The client sends the typed string RAW and writes it raw to Onyx optimistically; the SERVER is what
 * HTML-encodes it (see src/libs/actions/Report/index.ts updateReportName). So the bug is invisible
 * until the encoded value comes back — this script reloads at the end and prints what the list
 * actually renders, which is the proof the seed worked.
 *
 * Env: APP_URL, EXPENSIFY_EMAIL, OUT_DIR, NEW_TITLE.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const APP_URL = process.env.APP_URL ?? "https://dev.new.expensify.com:8082";
const EMAIL = process.env.EXPENSIFY_EMAIL;
const OUT_DIR = process.env.OUT_DIR ?? "screenshots";
// Characters chosen from the ACTUAL bug screenshot on the issue, which shows £ -> &#163;,
// < > -> &lt; &gt;, © -> &copy; and ' -> &#39;. An earlier attempt used `Bob's R&D "Q3"` and came
// back completely unencoded — so a bare ampersand is NOT what triggers this, and guessing at the
// characters cost a run. These are the ones the report itself proves get encoded.
const NEW_TITLE = process.env.NEW_TITLE ?? `John's <Internal> £100 © R&D`;
const SEARCH_ROUTE = "/search?q=" + encodeURIComponent("type:expense-report");

if (!EMAIL) {
  throw new Error("EXPENSIFY_EMAIL is not set");
}
mkdirSync(OUT_DIR, { recursive: true });

const shoot = (page, name) =>
  page.screenshot({ path: path.join(OUT_DIR, `seed-${name}.png`) });

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

  // Open the first expense report from the Reports list.
  await page.goto(`${APP_URL}${SEARCH_ROUTE}`, {
    waitUntil: "domcontentloaded",
  });
  // Clicking the title TEXT does not navigate — the row exposes an explicit "View" button, which is
  // what actually opens the report.
  const view = page.getByRole("button", { name: /^View$/ }).first();
  await view.waitFor({ state: "visible", timeout: 90_000 });
  await view.click();
  await page.waitForURL(/\/r\/\d+/, { timeout: 60_000 });
  await page.waitForTimeout(6_000);
  await shoot(page, "1-report");

  // The report ID is in the URL — /r/<id>. Everything after this is driven off it, so a changed
  // header layout cannot silently send us to the wrong page.
  const reportID = page.url().match(/\/r\/(\d+)/)?.[1];
  console.log(`report URL: ${page.url()} -> reportID=${reportID}`);
  if (!reportID) {
    throw new Error("could not determine the report ID from the URL");
  }

  // The rename field lives on the report details page.
  await page.goto(`${APP_URL}/r/${reportID}/details`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(6_000);
  await shoot(page, "2-details");
  console.log("=== DETAILS PAGE ===");
  console.log(JSON.stringify(await visibleNames(page), null, 1));

  // The row is labelled "Title, <current name>" — an aria-label, not a menuitem role.
  const titleField = page.locator('[aria-label^="Title,"]').first();
  await titleField.waitFor({ state: "visible", timeout: 30_000 });
  await titleField.click();
  await page.waitForTimeout(4_000);
  await shoot(page, "3-edit-field");

  const input = page.getByRole("textbox").first();
  await input.waitFor({ state: "visible", timeout: 30_000 });
  // What the input is PREFILLED with matters: if it already shows entities, that is the separate
  // DynamicEditReportFieldPage decode bug, and it is worth reporting.
  console.log(`prefilled value: ${JSON.stringify(await input.inputValue())}`);
  await input.fill(NEW_TITLE);
  await shoot(page, "4-typed");

  const save = page.getByRole("button", { name: /save|done/i }).last();
  await save.click({ timeout: 20_000 });
  await page.waitForTimeout(8_000);
  await shoot(page, "5-saved");

  // Force the server value: a full reload discards the optimistic (raw) Onyx write.
  console.log("=== reloading to pull the SERVER-encoded name ===");
  await page.goto(`${APP_URL}${SEARCH_ROUTE}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(15_000);
  await shoot(page, "6-after-reload");

  const renamed = page.getByText(/John/i).first();
  if (await renamed.isVisible().catch(() => false)) {
    console.log(
      `SEEDED. list now renders: ${JSON.stringify(await renamed.textContent())}`,
    );
  } else {
    console.log("WARNING: no row matching /John/ — the rename may not have saved");
  }
} catch (error) {
  await shoot(page, "failure").catch(() => {});
  throw error;
} finally {
  await context.close();
  await browser.close();
}
