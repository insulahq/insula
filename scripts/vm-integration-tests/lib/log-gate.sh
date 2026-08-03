#!/usr/bin/env bash
# scripts/vm-integration-tests/lib/log-gate.sh — judge a bootstrap by what it
# SAID, not only by what it returned.
#
# Why this exists. Every gate the VM tier had judged a bootstrap on its exit
# code (waitfor.sh: /tmp/bootstrap.exit) and on cluster health afterwards. Both
# were satisfied for months by a run that printed, on every node, on every OS:
#
#   bootstrap.sh: line 4718: op:: command not found
#   bootstrap.sh: line 4718: kustomize: command not found        (+5 more)
#
# The output was captured every time -- `--remote` runs bootstrap with
# `>>/var/log/hosting-platform-bootstrap.log 2>&1` -- streamed past a human
# dozens of times, and never asserted on. Nothing was missing except a reader.
#
# Two severities, deliberately:
#
#   FATAL   patterns that cannot be anything but a defect in our own scripts:
#           an unresolved command, a syntax error, an unbound variable, a
#           shell-level redirection failure. These fail the run outright.
#
#   NOTICE  warnings. Reported with counts, never fatal. Some are legitimate
#           operator-facing advice ("host iptables tools absent"), and a gate
#           that fails on every WARN gets disabled within a week. Counting them
#           makes a regression visible -- a run that suddenly warns twice as
#           much is worth looking at even when it passes.
#
# The FATAL list is intentionally short. Every entry is a pattern with no benign
# interpretation; anything arguable belongs in NOTICE.

# The primary rule, and the one that matters: bash reports an error inside a
# script as `<path>.sh: line <n>: <what>`. That shape is never legitimate output
# — it is our own interpreter telling us our own script is broken — and it
# catches `command not found`, `syntax error`, `unbound variable` and a failed
# redirection in one precise pattern, with no exemption list to get wrong.
#
# An earlier version of this file listed the symptoms individually plus
# exemptions like `command not found.*|| true`. That was matched as a REGEX, so
# the `|` was alternation and the pattern exempted every line containing
# "command not found" — the gate reported the shipped bug as clean. Hence: one
# structural rule, and standalone patterns only where no script prefix exists.
# shellcheck disable=SC2034
LOG_GATE_FATAL_PATTERNS=(
  '\.sh: line [0-9]+:'           # any bash-reported error inside one of our scripts
  'Argument list too long'       # E2BIG — killed sync-development-changelog once
  'cannot execute binary file'   # wrong-arch or truncated download
)

# log_gate_scan <logfile> [label] — prints a verdict, returns non-zero on FATAL.
log_gate_scan() {
  local log="$1" label="${2:-bootstrap}"
  if [[ ! -r "$log" ]]; then
    echo "  log-gate(${label}): NO LOG at ${log} — cannot judge this run" >&2
    return 2
  fi

  local fatal_hits=() pat line
  for pat in "${LOG_GATE_FATAL_PATTERNS[@]}"; do
    while IFS= read -r line; do
      [[ -n "$line" ]] && fatal_hits+=("$line")
    done < <(grep -aE "$pat" "$log" 2>/dev/null || true)
  done

  # `grep -c || echo 0` prints TWO zeros when there are no matches: grep already
  # writes its own "0" and exits 1, then the fallback fires. Take grep's answer
  # and normalise it instead.
  local warns
  warns=$(grep -acE '(^|\] )WARN:' "$log" 2>/dev/null) || warns=0
  warns="${warns:-0}"

  if (( ${#fatal_hits[@]} > 0 )); then
    echo "  log-gate(${label}): FAIL — ${#fatal_hits[@]} line(s) that can only be a script defect:" >&2
    printf '      %s\n' "${fatal_hits[@]}" | head -20 >&2
    (( ${#fatal_hits[@]} > 20 )) && echo "      … and $(( ${#fatal_hits[@]} - 20 )) more" >&2
    echo "    Full log: ${log}" >&2
    return 1
  fi

  echo "  log-gate(${label}): clean (${warns} warning(s))"
  return 0
}

# log_gate_fetch_and_scan <ip> <label> [ssh-key] — pull a node's bootstrap
# transcript and scan it. Keeps the copy on failure so it can be read after the
# VMs are gone, which is exactly when it is wanted.
log_gate_fetch_and_scan() {
  local ip="$1" label="${2:-$1}" key="${3:-$VMTEST_SSH_KEY}"
  local dest="${VMTEST_TMP_DIR:-/tmp}/bootstrap-${label}.log"
  scp -q -i "$key" -o StrictHostKeyChecking=no \
      "root@${ip}:/var/log/hosting-platform-bootstrap.log" "$dest" 2>/dev/null || {
    echo "  log-gate(${label}): could not fetch the transcript from ${ip}" >&2
    return 2
  }
  log_gate_scan "$dest" "$label"
}
