# newdot-evidence

Captures per-platform screenshot evidence for Expensify/App PRs in GitHub Actions, so a fix can be
evidenced without owning a Mac and without running the app on a memory-constrained laptop.

It only ever **reads** the fix branch from a public repo. Nothing here touches Expensify/App: no
fork branch, no workflow file in the fork, nothing that can leak into a PR diff.

## Why this repo must stay public

Standard GitHub-hosted runners — **macOS included** — are free and unlimited on public repos. On a
private repo, macOS minutes bill at a **10x multiplier** against a ~2,000 min/month quota, which is
about 3 iOS builds. The free macOS runner is the entire point, so: public.

Consequence: **run logs and uploaded artifacts are world-downloadable.** Artifacts expire after 1
day (`retention-days: 1`) and can be deleted immediately from the run page. Never capture anything
you would not paste into the PR itself.

## Sign-in

The dev server proxies to the **production** API (`src/CONFIG.ts` defaults to
`https://www.expensify.com/` when the App has no `.env`), so login needs the real 6-digit code
Expensify emails. The `000000` shortcut only works against a local backend — it does not apply here.

`scripts/magic_code.py` polls the inbox over IMAP and rejects any email older than the moment the
code was requested, so a stale code can never be reused.

Use a **dedicated throwaway Expensify account**, never a personal one: CI signs into a real account
over the real API, and its screenshots land in a public artifact.

## Secrets (Settings → Secrets and variables → Actions)

| Secret              | Value                                                              |
| ------------------- | ------------------------------------------------------------------ |
| `EXPENSIFY_EMAIL`   | the throwaway account's address                                    |
| `IMAP_USER`         | the mailbox that receives its magic codes                          |
| `IMAP_APP_PASSWORD` | a Gmail **App Password** — a normal password will not authenticate |

## Run

```bash
gh workflow run screenshot-evidence.yml --repo <owner>/newdot-evidence \
   -f source_repo=shivang-goliyan/App \
   -f target_ref=<fix-branch> \
   -f route=/search
```

Then download the artifact from the run and paste the images into the PR.
