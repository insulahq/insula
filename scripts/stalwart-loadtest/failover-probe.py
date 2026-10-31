#!/usr/bin/env python3
"""failover-probe.py — what a node loss costs, measured the same way for every mail shape (ADR-065).

  send   deliver one message every 1/RATE s over SMTP for DURATION s, each to its own session, and log
         every attempt with its time and outcome (accepted, temporary failure, refused, timeout)
  check  sign in over IMAP and list which accepted messages the server holds, in any folder

The two together give the recovery time (the longest stretch in which nothing was accepted) and the
data loss (messages the server accepted with 250 and no longer holds), against the time of the cut.
Standard library only. Each message comes from its own sender domain: Stalwart's default inbound
throttle allows 25 messages an hour per sender domain and recipient, which a steady probe would hit.

  send  --host H [--port 25] --rcpt ADDR --rate R --duration S --run ID --log FILE
  check --host H [--port 143] --user LOGIN --password-env VAR --run ID --log FILE [--cut EPOCH]
"""
import argparse
import imaplib
import json
import os
import smtplib
import socket
import ssl
import sys
import time

TLS = ssl.create_default_context()
TLS.check_hostname = False
TLS.verify_mode = ssl.CERT_NONE  # lab certificates


def message(run: str, seq: int, rcpt: str) -> bytes:
    return (f"From: probe@p{seq % 997}.probe.example.test\r\nTo: {rcpt}\r\n"
            f"Subject: failover probe {run} {seq}\r\nMessage-ID: <probe-{seq}-{run}@probe.example.test>\r\n"
            f"Date: {time.strftime('%a, %d %b %Y %H:%M:%S +0000', time.gmtime())}\r\n\r\n"
            f"probe {seq} of run {run}\r\n").encode()


def one(a: argparse.Namespace, seq: int) -> dict:
    t0 = time.time()
    row = {"seq": seq, "t": round(t0, 3)}
    try:
        s = smtplib.SMTP(a.host, a.port, timeout=5, local_hostname="probe.example.test")
        try:
            s.ehlo()
            if s.has_extn("starttls"):
                s.starttls(context=TLS)
                s.ehlo()
            s.sendmail(f"probe@p{seq % 997}.probe.example.test", [a.rcpt], message(a.run, seq, a.rcpt))
            row["result"] = "accepted"
        finally:
            try:
                s.quit()
            except Exception:  # noqa: BLE001
                pass
    except smtplib.SMTPResponseException as exc:
        row["result"] = "temp-fail" if 400 <= exc.smtp_code < 500 else "rejected"
        row["code"] = exc.smtp_code
    except smtplib.SMTPRecipientsRefused as exc:
        codes = [c for c, _ in exc.recipients.values()]
        row["result"] = "temp-fail" if codes and 400 <= codes[0] < 500 else "rejected"
        row["code"] = codes[0] if codes else None
    except (socket.timeout, TimeoutError):
        row["result"] = "timeout"
    except (ConnectionError, OSError, smtplib.SMTPException) as exc:
        row["result"] = "refused" if isinstance(exc, ConnectionRefusedError) else "error"
        row["error"] = f"{type(exc).__name__}: {str(exc)[:80]}"
    row["ms"] = round((time.time() - t0) * 1000)
    return row


def cmd_send(a: argparse.Namespace) -> dict:
    start, seq, n = time.time(), 0, {}
    with open(a.log, "a", buffering=1) as f:
        while time.time() - start < a.duration:
            due = start + seq / a.rate
            if due > time.time():
                time.sleep(due - time.time())
            row = one(a, seq)
            f.write(json.dumps(row) + "\n")
            n[row["result"]] = n.get(row["result"], 0) + 1
            seq += 1
    return {"run": a.run, "sent": seq, "results": n}


def present(a: argparse.Namespace) -> set[int]:
    m = imaplib.IMAP4(a.host, a.port, timeout=60)
    if "STARTTLS" in m.capabilities:
        m.starttls(ssl_context=TLS)
    m.login(a.user, os.environ[a.password_env])
    seqs = set()
    typ, boxes = m.list()
    for line in boxes or []:
        if not isinstance(line, bytes) or b"\\Noselect" in line:
            continue
        name = line.decode().rsplit(" ", 1)[1] if not line.endswith(b'"') else '"' + line.decode().rsplit(' "', 1)[1]
        typ, data = m.select(name, readonly=True)
        if typ != "OK" or int(data[0]) == 0:
            continue
        typ, hits = m.search(None, "SUBJECT", f"failover probe {a.run}")
        ids = (hits[0] or b"").split()
        for i in range(0, len(ids), 500):
            typ, rows = m.fetch(b",".join(ids[i:i + 500]), "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
            for r in rows:
                if isinstance(r, tuple) and b"probe-" in r[1]:
                    seqs.add(int(r[1].split(b"probe-", 1)[1].split(b"-", 1)[0]))
    m.logout()
    return seqs


def cmd_check(a: argparse.Namespace) -> dict:
    rows = [json.loads(x) for x in open(a.log) if x.strip()]
    accepted = {r["seq"]: r["t"] for r in rows if r["result"] == "accepted"}
    have = present(a)
    lost = sorted(s for s in accepted if s not in have)
    out = {"run": a.run, "attempts": len(rows), "accepted": len(accepted), "present": len(have & set(accepted)),
           "lost": len(lost), "results": {}}
    for r in rows:
        out["results"][r["result"]] = out["results"].get(r["result"], 0) + 1
    ts = sorted(accepted.values())
    gaps = sorted(((b - a_, a_) for a_, b in zip(ts, ts[1:])), reverse=True)[:3]
    out["longest_no_accept_s"] = [{"seconds": round(g, 1), "from": round(t, 1)} for g, t in gaps]
    if a.cut:
        out["cut"] = a.cut
        out["lost_accepted_before_cut_s"] = [round(a.cut - accepted[s], 1) for s in lost][:50]
        if gaps:
            first_after = next((t for t in ts if t > a.cut), None)
            out["first_accept_after_cut_s"] = round(first_after - a.cut, 1) if first_after else None
    out["lost_seqs"] = lost[:50]
    return out


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("send")
    s.add_argument("--host", required=True)
    s.add_argument("--port", type=int, default=25)
    s.add_argument("--rcpt", required=True)
    s.add_argument("--rate", type=float, default=2.0)
    s.add_argument("--duration", type=int, default=900)
    c = sub.add_parser("check")
    c.add_argument("--host", required=True)
    c.add_argument("--port", type=int, default=143)
    c.add_argument("--user", required=True)
    c.add_argument("--password-env", required=True)
    c.add_argument("--cut", type=float, default=0)
    for x in (s, c):
        x.add_argument("--run", required=True)
        x.add_argument("--log", required=True)
    a = p.parse_args()
    out = cmd_send(a) if a.cmd == "send" else cmd_check(a)
    json.dump(out, sys.stdout, indent=1)
    print()


if __name__ == "__main__":
    main()
