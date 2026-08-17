# Console output — the shared contract

One visual language for everything an operator watches `insula` do. Two
implementations, because the binary has two runtimes:

| Surface | Implementation | Used by |
|---|---|---|
| bash | [`scripts/lib/ui.sh`](../../scripts/lib/ui.sh) | `bootstrap.sh` and the shell helpers it sources |
| TypeScript | `backend/src/cli/platform-ops/ui.ts` | `doctor`, `cluster upgrade`, `self-upgrade`, `dr`, `host-config`, … |

They must stay interchangeable: an operator should not be able to tell which one
produced a given line, and the plain-mode prefixes below are parsed by tooling.

## Why this exists

A bootstrap run emitted several thousand lines of kubectl/helm/k3s chatter. The
things an operator had to read — a warning, a failure, which phase was running —
were typographically identical to the noise around them. Seven `command not
found` errors rode in that stream through a dozen releases without anyone
reacting to them, and every automated gate passed the whole time because the exit
code was 0.

The conclusion drawn was not "log less". It was **separate what is recorded from
what is shown**: keep an exhaustive transcript on disk, and put only decisions,
outcomes and problems on the screen.

## Model

- **Phase** — the unit of progress, rendered `[3/5] Installing platform` with a
  bar. A run declares its total up front so progress is a fraction, not an
  open-ended count.
- **Step** — work inside a phase. A step's command output is **captured, not
  streamed**. On success one line survives; on failure the label, the exit code
  and the **full** captured output are replayed, at the moment it is needed.
- **OK / WARN / ERROR** — the only things that outlive a successful run.
  Anything still on screen at the end is therefore worth reading.
- **Summary** — final line, carrying the warning and error tally and the phases
  actually reached.

Two rules that are easy to get wrong, and were:

1. **Never draw a full progress bar for an incomplete run.** A run that stopped
   at phase 3 of 9 reports `3/9`, never a bar forced to 100%. Signing off as
   complete when you are not is the exact failure this whole layer exists to
   prevent.
2. **A degraded transcript is not a failed run.** If the log file cannot be
   written, drop it silently and carry on — and probe writability with `touch`,
   not `: >>"$f" 2>/dev/null`, because a failed *redirection* is reported by the
   shell itself and `2>/dev/null` will not suppress it.

## Modes

Chosen automatically; never guessed at per call site.

**rich** — stdout is a TTY, `NO_COLOR` unset, `TERM` not `dumb`, `CI` not
`true`. Colour, in-place step updates, progress bars.

**plain** — anything else, or `--plain`. One self-contained line per event:

```
PHASE: [2/5] Installing Kubernetes (k3s)
STEP: install k3s v1.36.2
OK: install k3s v1.36.2
INFO: node ready: node-1
WARN: host iptables tools absent — k3s will use its bundled copy
ERROR: apply Flux Kustomization (exit 1)
SUMMARY: Bootstrap complete (5/5 phases)
```

**Plain mode is a contract, not a fallback.** `--remote` streams it to the
operator, CI captures it, and the VM harness log gate greps it. Prefixes and
wording are asserted in `scripts/test-ui.sh`; changing them is a breaking change.

Stream routing matters as much as the prefix: `OK`/`INFO`/`PHASE`/`STEP` go to
stdout, `WARN`/`ERROR` to stderr, so `2>/dev/null` still yields a usable
transcript and a caller can isolate problems.

## Suppressing command output safely

`bootstrap.sh` wraps `kubectl` and `helm` so a chart install contributes one line
instead of forty. The wrappers key off `[ -t 1 ]` — *is my stdout the terminal
right now?*

- **Command substitution / redirect** → stdout is a pipe → **pass through
  untouched.** Over a hundred call sites read `$(kctl get … -o jsonpath=…)`;
  swallowing stdout there returns empty strings and breaks the install in a way
  that reads like a cluster fault.
- **Statement position on a TTY** → nobody is reading them → capture, record to
  the transcript, and surface only on failure.

`scripts/test-bootstrap-quiet-wrappers.sh` proves both paths against a real pty
(via `script(1)`), because the distinction cannot be exercised in a plain
subshell.

## Adding output to a new surface

Emit outcomes, not narration. Before adding a line, ask which of these it is:

- a **phase** boundary → `ui_phase` / `ui.phase()`
- a **step** whose success is uninteresting → `ui_run` / `ui.run()`; let it be
  silent when it works
- an **outcome** the operator acts on → `ui_ok` / `ui_warn` / `ui_fail`
- **context** worth showing but not an outcome (an endpoint, a chosen value) →
  `ui_detail` / `ui.detail()`
- part of the **end-of-run report** → `ui_banner` / `ui_section` / `ui_line`
- none of the above → it belongs in the transcript only: `ui_record`

If it would be identical on a healthy run and a broken one, it is noise.

## The completion report

The end-of-run report is the one screen an operator reads start to finish, so it
gets its own register — green headline, green section headings, undimmed body:

```
ui_banner  "BOOTSTRAP COMPLETE"      → green rule / title / rule
ui_section "Endpoints"               → green heading inside the report
ui_line    "Admin: https://admin/…"  → body text, NOT dimmed
```

`ui_line` is deliberately distinct from `ui_detail`: detail is dim because it is
incidental context during a run; report body is not, because it is the payload.
Building a report out of `ui_detail` (which is what bootstrap.sh's legacy `log()`
maps to) renders a successful install entirely in grey, with an admin URL styled
identically to a passing kubectl tip. Asserted in `scripts/test-bootstrap-summary.sh`.

Body text uses the terminal's **default foreground**, never an explicit white.
Forcing `\033[37m` is right on the dark terminals most operators use and
unreadable on a light one.

### Advisory results belong in the report, not after it

An advisory step — one that cannot fail the run — must not emit `ui_warn`, and
must not print after the report. Post-install smoke did both: two yellow warnings
("Smoke FAILED", "Bootstrap exits 0 because --require-smoke-pass was not set")
were the last thing on screen after a successful install, which reads as a failed
install regardless of what the banner said. Advisory steps now run **before** the
report and hand it a verdict to render as one factual line.

A gate the operator explicitly opted into (`--require-smoke-pass`) is not
advisory and stays a fatal `ui_fail`.
