#!/usr/bin/env python3
"""Fetch the Expensify sign-in magic code from an IMAP inbox.

NewDot's dev server talks to the PRODUCTION API (src/CONFIG.ts defaults to
https://www.expensify.com/ when there is no .env), so signing in needs the real
6-digit code that Expensify emails. The '000000' shortcut only works against a
LOCAL backend (EXPENSIFY_URL=…expensify.com.dev) — not here.

Polls for a message that arrived AFTER --since (epoch seconds), so a code left
over from an earlier run can never be reused. Prints the code to stdout.

Env: IMAP_HOST (default imap.gmail.com), IMAP_USER, IMAP_APP_PASSWORD.
Gmail requires an App Password — a normal password will not authenticate.
"""
from __future__ import annotations

import argparse
import email
import imaplib
import os
import re
import sys
import time
from email.utils import parsedate_to_datetime

CODE_RE = re.compile(r"\b(\d{6})\b")


def _bodies(msg: email.message.Message):
    """Yield every text part of a message (plain and html)."""
    if not msg.is_multipart():
        yield msg.get_payload(decode=True) or b""
        return
    for part in msg.walk():
        if part.get_content_maintype() == "text":
            yield part.get_payload(decode=True) or b""


def find_code(host: str, user: str, password: str, since: float, timeout: int) -> str | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with imaplib.IMAP4_SSL(host) as imap:
                imap.login(user, password)
                imap.select("INBOX")
                # Server-side date filter is day-granular, so re-check each hit against
                # `since` below — that's what actually rejects a stale code.
                day = time.strftime("%d-%b-%Y", time.gmtime(since))
                _, data = imap.search(None, f'(SINCE "{day}" FROM "expensify.com")')
                for num in reversed((data[0] or b"").split()):
                    _, raw = imap.fetch(num, "(RFC822)")
                    if not raw or not isinstance(raw[0], tuple):
                        continue
                    msg = email.message_from_bytes(raw[0][1])
                    try:
                        arrived = parsedate_to_datetime(msg["Date"]).timestamp()
                    except Exception:
                        continue
                    if arrived < since:
                        continue
                    subject = msg.get("Subject") or ""
                    haystack = subject + " " + " ".join(
                        b.decode("utf-8", "replace") for b in _bodies(msg)
                    )
                    m = CODE_RE.search(haystack)
                    if m:
                        return m.group(1)
        except imaplib.IMAP4.error as e:
            print(f"imap error: {e}", file=sys.stderr)
        time.sleep(5)
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=float, required=True, help="epoch seconds; ignore older mail")
    ap.add_argument("--timeout", type=int, default=120, help="seconds to keep polling")
    args = ap.parse_args()

    user, password = os.environ.get("IMAP_USER"), os.environ.get("IMAP_APP_PASSWORD")
    if not user or not password:
        print("IMAP_USER / IMAP_APP_PASSWORD not set", file=sys.stderr)
        return 2

    code = find_code(os.environ.get("IMAP_HOST", "imap.gmail.com"), user, password,
                     args.since, args.timeout)
    if not code:
        print(f"no magic code from expensify.com within {args.timeout}s", file=sys.stderr)
        return 1
    print(code)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
