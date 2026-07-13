/**
 * Ground truth for #95808: what does the SERVER actually store in reportName?
 *
 * The rendered text already told us the seeded report is NOT stored encoded, which falsified the
 * "the backend HTML-encodes report names" assumption every proposal on the thread (ours included)
 * is built on. Rendering can mislead, though, so this reads Onyx straight out of IndexedDB — the
 * bytes the server sent, with no component in between.
 *
 * It dumps every report's reportName plus the policy names, and flags any value containing an HTML
 * entity. If ANY report on the account is stored encoded, its shape tells us which write path does
 * the encoding — which is the thing nobody on the thread has actually established.
 *
 * Env: APP_URL, EXPENSIFY_EMAIL, OUT_DIR.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const APP_URL = process.env.APP_URL ?? "https://dev.new.expensify.com:8082";
const EMAIL = process.env.EXPENSIFY_EMAIL;
const OUT_DIR = process.env.OUT_DIR ?? "screenshots";

if (!EMAIL) {
  throw new Error("EXPENSIFY_EMAIL is not set");
}
mkdirSync(OUT_DIR, { recursive: true });

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

  // Visit the reports list so the Search snapshot (and every report in it) is hydrated into Onyx.
  await page.goto(
    `${APP_URL}/search?q=${encodeURIComponent("type:expense-report")}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForTimeout(20_000);

  // Onyx persists to IndexedDB on web (IDBKeyValProvider). Enumerate every database/store rather
  // than hardcoding a name — the provider's naming is an implementation detail we should not pin.
  const dump = await page.evaluate(async () => {
    const openDB = (name) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const readAll = (db, storeName) =>
      new Promise((resolve) => {
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        const keysReq = store.getAllKeys();
        const valsReq = store.getAll();
        tx.oncomplete = () => resolve({ keys: keysReq.result, vals: valsReq.result });
        tx.onerror = () => resolve({ keys: [], vals: [] });
      });

    const out = { databases: [], reports: [], policies: [] };
    const dbs = await indexedDB.databases();
    for (const { name } of dbs) {
      out.databases.push(name);
      const db = await openDB(name);
      for (const storeName of [...db.objectStoreNames]) {
        const { keys, vals } = await readAll(db, storeName);
        keys.forEach((key, i) => {
          const v = vals[i];
          if (typeof key !== "string" || !v || typeof v !== "object") return;
          if (key.startsWith("report_") && "reportName" in v) {
            out.reports.push({
              key,
              reportName: v.reportName,
              type: v.type,
              policyID: v.policyID,
            });
          }
          if (key.startsWith("policy_") && "name" in v) {
            out.policies.push({ key, name: v.name });
          }
        });
      }
      db.close();
    }
    return out;
  });

  const hasEntity = (s) => typeof s === "string" && /&(amp|quot|#\d+|lt|gt);/.test(s);

  console.log(`=== IndexedDB databases: ${JSON.stringify(dump.databases)} ===`);
  console.log(`=== ${dump.reports.length} reports in Onyx ===`);
  for (const r of dump.reports) {
    console.log(
      `${hasEntity(r.reportName) ? "ENCODED >>" : "  plain  "} [${r.type}] ${JSON.stringify(r.reportName)}`,
    );
  }
  console.log(`=== ${dump.policies.length} policies ===`);
  for (const p of dump.policies) {
    console.log(
      `${hasEntity(p.name) ? "ENCODED >>" : "  plain  "} ${JSON.stringify(p.name)}`,
    );
  }

  const encoded = [
    ...dump.reports.filter((r) => hasEntity(r.reportName)),
    ...dump.policies.filter((p) => hasEntity(p.name)),
  ];
  console.log(
    encoded.length
      ? `VERDICT: ${encoded.length} value(s) ARE stored entity-encoded.`
      : "VERDICT: nothing on this account is stored entity-encoded.",
  );

  writeFileSync(
    path.join(OUT_DIR, "onyx-dump.json"),
    JSON.stringify(dump, null, 2),
  );
} finally {
  await context.close();
  await browser.close();
}
