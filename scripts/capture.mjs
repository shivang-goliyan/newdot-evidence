/**
 * Sign in to the NewDot dev server and capture PR screenshot evidence.
 *
 * Login is the hard part in CI: the dev server hits the PRODUCTION API, so the
 * magic code must come from the account's inbox (magic_code.py). '000000' only
 * works against a local backend. We stamp the time BEFORE requesting the code so
 * a stale email can't satisfy the poll.
 *
 * Env: APP_URL, EXPENSIFY_EMAIL, ROUTE (post-login path), VIEWPORT ("1512x982"), OUT_DIR.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const APP_URL = process.env.APP_URL ?? "https://dev.new.expensify.com:8082";
const EMAIL = process.env.EXPENSIFY_EMAIL;
const ROUTE = process.env.ROUTE ?? "/";
const OUT_DIR = process.env.OUT_DIR ?? "screenshots";
const [width, height] = (process.env.VIEWPORT ?? "1512x982")
  .split("x")
  .map(Number);

if (!EMAIL) {
  throw new Error("EXPENSIFY_EMAIL is not set");
}
mkdirSync(OUT_DIR, { recursive: true });

/** Poll the inbox for a magic code emailed after `since` (epoch seconds). */
function fetchMagicCode(since) {
  const script = path.join(import.meta.dirname, "magic_code.py");
  return execFileSync(
    "python3",
    [script, "--since", String(since), "--timeout", "180"],
    {
      encoding: "utf8",
    },
  ).trim();
}

const shoot = (page, name) =>
  page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: false });

/**
 * Close any modal sitting over the app (promos, onboarding, "what's new").
 * Escape is deliberately not used: NewDot treats it as back-navigation, which
 * would move us off the route we were asked to screenshot.
 */
async function dismissModals(page) {
  for (let i = 0; i < 4; i++) {
    const close = page
      .getByRole("button", { name: /close|dismiss|got it|maybe later|skip/i })
      .first();
    if (!(await close.isVisible().catch(() => false))) {
      return;
    }
    await close.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(1_000);
  }
}

const browser = await chromium.launch();
// The dev server uses a locally-generated mkcert certificate the runner does not trust.
const context = await browser.newContext({
  viewport: { width, height },
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();

try {
  console.log(`opening ${APP_URL}`);
  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });

  // Never log the address itself: on a public fork, workflow logs are world-readable.
  console.log(`signing in as ${EMAIL.replace(/^(.).*(@.*)$/, "$1***$2")}`);
  const emailField = page.getByRole("textbox").first();
  await emailField.waitFor({ state: "visible", timeout: 120_000 });
  await emailField.fill(EMAIL);

  // Stamp BEFORE submitting: any code older than this is from a previous run.
  const requestedAt = Date.now() / 1000;
  await page.keyboard.press("Enter");

  const code = fetchMagicCode(requestedAt);
  console.log("got magic code from inbox");
  // The magic-code field renders as one input per digit; typing the whole string
  // into the focused field advances through them.
  await page.waitForTimeout(2_000);
  await page.keyboard.type(code, { delay: 120 });

  // The LHN is the first thing that renders once the session is real.
  await page.waitForSelector('[data-testid="BaseSidebarScreen"]', {
    timeout: 120_000,
  });
  console.log("signed in");

  // A fresh account gets greeted by promo/onboarding modals ("New to Concierge AI", …). They
  // would sit on top of whatever the PR is meant to show, so clear whatever is up.
  await dismissModals(page);

  if (ROUTE !== "/") {
    await page.goto(`${APP_URL}${ROUTE}`, { waitUntil: "domcontentloaded" });
    await dismissModals(page);
  }
  // Onyx hydrates after first paint; a settled network is the cheapest proxy for "done".
  await page
    .waitForLoadState("networkidle", { timeout: 60_000 })
    .catch(() => {});
  await shoot(page, "web-chrome");
  console.log(`captured ${OUT_DIR}/web-chrome.png`);
} catch (error) {
  await shoot(page, "failure").catch(() => {});
  throw error;
} finally {
  await browser.close();
}
