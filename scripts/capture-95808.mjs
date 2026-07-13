/**
 * Before/after evidence for Expensify/App#95808 — report list components do not parse HTML entities.
 *
 * The C+ asked every proposer for before/after results, so this runs TWICE against the SAME account
 * and the SAME seeded report: once on `main` (before) and once on the fix branch (after). Only the
 * checked-out ref differs, which is what makes the pair a fair comparison.
 *
 * It photographs both surfaces the proposal claims to fix:
 *   1. the Search expense-report list  -> ExpenseReportListItemRowWide / …Narrow
 *   2. the report preview card in chat -> MoneyRequestReportPreviewBody / ReportPreviewHeader
 *
 * The report must already exist on the account with an entity-bearing title (see SEED_TITLE_MATCH);
 * seeding is deliberately not automated, so a flaky create-flow can never be mistaken for the bug.
 *
 * Env: APP_URL, EXPENSIFY_EMAIL, OUT_DIR, LABEL ("before" | "after"), SEED_TITLE_MATCH.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const APP_URL = process.env.APP_URL ?? "https://dev.new.expensify.com:8082";
const EMAIL = process.env.EXPENSIFY_EMAIL;
const OUT_DIR = process.env.OUT_DIR ?? "screenshots";
const LABEL = process.env.LABEL ?? "before";
// Matched against the row text to find the seeded report. Deliberately a fragment that survives
// BOTH states: "R&amp;D" (buggy) and "R&D" (fixed) both contain "Bob".
const TITLE_MATCH = process.env.SEED_TITLE_MATCH ?? "John";
// The Search list of expense reports — the surface that renders ExpenseReportListItemRow*.
const SEARCH_ROUTE = "/search?q=" + encodeURIComponent("type:expense-report");

if (!EMAIL) {
  throw new Error("EXPENSIFY_EMAIL is not set");
}
mkdirSync(OUT_DIR, { recursive: true });

const shoot = (page, name) =>
  page.screenshot({ path: path.join(OUT_DIR, `${LABEL}-${name}.png`) });

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
  console.log("signed in");

  // Surface 1: the Search expense-report list.
  await page.goto(`${APP_URL}${SEARCH_ROUTE}`, {
    waitUntil: "domcontentloaded",
  });
  const row = page.getByText(new RegExp(TITLE_MATCH, "i")).first();
  await row.waitFor({ state: "visible", timeout: 90_000 });
  await page.waitForTimeout(3_000);
  await shoot(page, "1-search-report-list");

  // Read back what the row ACTUALLY renders. This is the assertion the screenshot only implies,
  // and it lands in the run log, so a reviewer can see the decode happened rather than trust a crop.
  const rendered = await row.textContent();
  console.log(`[${LABEL}] search row renders: ${JSON.stringify(rendered)}`);

  // Surface 2: the report preview card in chat. Opening the row navigates to the report; the
  // preview header renders the same name through a different path (derived report attributes).
  await row.click();
  await page.waitForTimeout(6_000);
  await shoot(page, "2-report-preview");

  const header = page.getByTestId("MoneyRequestReportPreview-reportName").first();
  if (await header.isVisible().catch(() => false)) {
    console.log(
      `[${LABEL}] preview header renders: ${JSON.stringify(await header.textContent())}`,
    );
  } else {
    console.log(`[${LABEL}] preview header not visible on this screen`);
  }
} catch (error) {
  await shoot(page, "failure").catch(() => {});
  throw error;
} finally {
  await context.close();
  await browser.close();
}
