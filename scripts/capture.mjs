/**
 * Sign in to the NewDot dev server and capture PR screenshot evidence.
 *
 * Login is the hard part in CI: the dev server hits the PRODUCTION API, so the
 * magic code must come from the account's inbox (magic_code.py). '000000' only
 * works against a local backend. We stamp the time BEFORE requesting the code so
 * a stale email can't satisfy the poll.
 *
 * Env: APP_URL, EXPENSIFY_EMAIL, ROUTE (post-login path), VIEWPORT ("1512x982"), OUT_DIR,
 *      RECORD ("true" to also produce an mp4 of the session), BROWSER ("chromium"|"webkit"),
 *      LABEL (output file stem), DESKTOP ("true" to also grab the whole macOS screen).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { chromium, webkit } from "playwright";

const APP_URL = process.env.APP_URL ?? "https://dev.new.expensify.com:8082";
const EMAIL = process.env.EXPENSIFY_EMAIL;
const ROUTE = process.env.ROUTE ?? "/";
const OUT_DIR = process.env.OUT_DIR ?? "screenshots";
const RECORD = process.env.RECORD === "true";
const BROWSER = process.env.BROWSER ?? "chromium";
const LABEL = process.env.LABEL ?? "web-chrome";
// A viewport screenshot looks the same on every OS — it has no window chrome. Grabbing the whole
// macOS screen (menu bar + traffic lights + the browser's own UI) is what actually EVIDENCES
// "this ran on a Mac in Chrome/Safari", which is the point of that row in the PR template.
const DESKTOP = process.env.DESKTOP === "true";
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

const engine = BROWSER === "webkit" ? webkit : chromium;
// Headed when we intend to photograph the screen — a headless browser draws no window to photograph.
const browser = await engine.launch({
  headless: !DESKTOP,
  ...(BROWSER === "chromium"
    ? {
        args: [
          "--disable-features=MediaRouter",
          "--disable-background-networking",
          "--no-first-run",
          "--no-default-browser-check",
        ],
      }
    : {}),
});
// The dev server uses a locally-generated mkcert certificate the runner does not trust.
const context = await browser.newContext({
  viewport: { width, height },
  ignoreHTTPSErrors: true,
  // Playwright only finalises the .webm when the context closes, so the file is
  // collected in the `finally` block, not here.
  ...(RECORD
    ? {
        recordVideo: {
          dir: path.join(OUT_DIR, "raw-video"),
          size: { width, height },
        },
      }
    : {}),
});
const page = await context.newPage();

// Recording starts when the context does, so the sign-in — including the magic code being
// typed in — is on the front of the tape. We remember when the app became usable and cut
// everything before it, so the published video never shows the OTP.
const recordingStartedAt = Date.now();
let appReadyAt = null;

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

  // Everything recorded up to here is sign-in (magic code included) — the video is cut here.
  appReadyAt = Date.now();

  if (ROUTE !== "/") {
    await page.goto(`${APP_URL}${ROUTE}`, { waitUntil: "domcontentloaded" });
    await dismissModals(page);
  }
  // Onyx hydrates after first paint; a settled network is the cheapest proxy for "done".
  await page
    .waitForLoadState("networkidle", { timeout: 60_000 })
    .catch(() => {});
  await shoot(page, LABEL);
  console.log(`captured ${OUT_DIR}/${LABEL}.png`);

  if (DESKTOP) {
    // -x = no shutter sound. Captures the real desktop: macOS menu bar, window controls, browser UI.
    // Screen capture can be denied by TCC on a CI host, and that must not lose the viewport shot
    // we already have — so a failure here is logged, not thrown.
    const shot = path.join(OUT_DIR, `${LABEL}-desktop.png`);
    try {
      // macOS raises a "hosted-compute- wants to find devices on local networks" alert — it is
      // the GITHUB RUNNER AGENT that trips it, not the browser, so no Chrome flag suppresses it.
      // It is drawn by UserNotificationCenter, which respawns harmlessly when killed.
      execFileSync("bash", ["-c", "killall UserNotificationCenter 2>/dev/null; sleep 1"]);
      execFileSync("screencapture", ["-x", shot]);
      console.log(`captured ${shot} (full macOS screen)`);
    } catch (e) {
      console.log(`desktop capture unavailable: ${e.message}`);
    }
  }
} catch (error) {
  await shoot(page, "failure").catch(() => {});
  throw error;
} finally {
  const video = RECORD ? page.video() : null;
  // Closing the context is what flushes the .webm to disk — ask for its path only after.
  await context.close();
  if (video) {
    const webm = await video.path();
    const mp4 = path.join(OUT_DIR, `${LABEL}.mp4`);
    // Drop the sign-in from the front of the tape. If we never got that far (a failure run),
    // publish nothing rather than a video of the magic code being typed.
    const skip = appReadyAt ? (appReadyAt - recordingStartedAt) / 1000 : null;
    try {
      if (skip === null) {
        throw new Error(
          "never reached the app — refusing to publish the sign-in footage",
        );
      }
      // -ss AFTER -i so the cut is frame-accurate (before -i it seeks to the nearest keyframe).
      // mp4 because GitHub plays it inline and will not render a .webm.
      execFileSync(
        "ffmpeg",
        [
          "-y",
          "-i",
          webm,
          "-ss",
          skip.toFixed(2),
          "-movflags",
          "faststart",
          "-pix_fmt",
          "yuv420p",
          mp4,
        ],
        {
          stdio: "ignore",
        },
      );
      console.log(`recorded ${mp4} (trimmed ${skip.toFixed(1)}s of sign-in)`);
    } catch (e) {
      console.log(`video not published: ${e.message}`);
    }
    // The raw webm always holds the sign-in, so it never survives the run.
    rmSync(path.join(OUT_DIR, "raw-video"), { recursive: true, force: true });
  }
  await browser.close();
}
