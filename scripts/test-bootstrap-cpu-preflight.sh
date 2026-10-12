#!/usr/bin/env bash
# TDD harness for the x86-64-v2 CPU check: bootstrap.sh's preflight helper and
# the host-migration that makes the same check on upgrade.
# Run: ./scripts/test-bootstrap-cpu-preflight.sh   (exit 0 = all pass)
#
# Why this exists: the mail server (Stalwart, from v0.16.26) exits at start on an
# x86-64 CPU below x86-64-v2 — a virtual machine with a generic CPU model. An
# install or a join there succeeds and mail then never starts; an upgrade there
# takes a working mail server down. Both paths now refuse first, and each side
# of the refusal is tested here: a check that only ever passes proves nothing.
#
# The helper is extracted from the SHIPPED script and the migration is run as
# shipped, each against fake /proc/cpuinfo files.
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
BOOTSTRAP="$REPO_ROOT/scripts/bootstrap.sh"
MIGRATION="$REPO_ROOT/platform/host-migrations/2026.10.8/0001-require-x86-64-v2-cpu.sh"

pass=0; fail=0
ok()    { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — expected [$2], got [$3]"; fi; }
has()   { if grep -qF -- "$2" <<<"$1"; then ok "$3"; else bad "$3 — not found: $2"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Flag lines. `modern` (shortened) and `qemu64` are as read from /proc/cpuinfo
# on a host-passthrough VM and on a VM given QEMU's qemu64 model — the one on
# which Stalwart v0.16.26 was seen to refuse to start. The other two are made up
# to cover the remaining shapes: one also lacking lahf_lm, and one that has
# popcnt and cx16 but neither ssse3 nor sse4 (an AMD K10 looks like that).
cat > "$WORK/modern"  <<'C'
processor	: 0
model name	: 12th Gen Intel(R) Core(TM) i7-12700K
flags		: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ss ht syscall nx pdpe1gb rdtscp lm constant_tsc pni pclmulqdq ssse3 fma cx16 pcid sse4_1 sse4_2 x2apic movbe popcnt aes xsave avx f16c rdrand hypervisor lahf_lm abm avx2
C
cat > "$WORK/qemu64"  <<'C'
processor	: 0
model name	: QEMU Virtual CPU version 2.5+
flags		: fpu de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 syscall nx lm constant_tsc nopl xtopology cpuid tsc_known_freq pni cx16 x2apic hypervisor lahf_lm cpuid_fault pti
C
cat > "$WORK/no-lahf" <<'C'
processor	: 0
model name	: made up: generic, and without lahf_lm
flags		: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 syscall nx lm constant_tsc nopl xtopology cpuid tsc_known_freq pni cx16 x2apic hypervisor cpuid_fault pti
C
cat > "$WORK/k10"     <<'C'
processor	: 0
model name	: made up: popcnt and cx16, no ssse3, no sse4
flags		: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ht syscall nx mmxext fxsr_opt pdpe1gb rdtscp lm 3dnowext 3dnow constant_tsc rep_good nopl nonstop_tsc cpuid extd_apicid pni monitor cx16 popcnt lahf_lm cmp_legacy svm extapic cr8_legacy abm sse4a misalignsse
C
# A flag that only CONTAINS a wanted name must not count: sse4a is not sse4_1.
cat > "$WORK/lookalike" <<'C'
flags		: fpu sse sse2 pni ssse3 cx16 sse4a sse4_1x xsse4_2 popcnt_fake lahf_lm
C

echo "── bootstrap.sh: cpu_missing_x86_64_v2 ──"
sed -n '/^cpu_missing_x86_64_v2() {/,/^}/p' "$BOOTSTRAP" > "$WORK/helper.sh"
[[ -s "$WORK/helper.sh" ]] || { bad "helper cpu_missing_x86_64_v2 not found in bootstrap.sh"; echo "passed=$pass failed=$fail"; exit 1; }
# shellcheck disable=SC1091
source "$WORK/helper.sh"
check "a current CPU lacks nothing"            ""                                   "$(cpu_missing_x86_64_v2 "$WORK/modern" x86_64)"
check "qemu64 lacks ssse3, sse4 and popcnt"    "ssse3 sse4_1 sse4_2 popcnt"         "$(cpu_missing_x86_64_v2 "$WORK/qemu64" x86_64)"
check "one also lacking lahf_lm says so"       "ssse3 sse4_1 sse4_2 popcnt lahf_lm" "$(cpu_missing_x86_64_v2 "$WORK/no-lahf" x86_64)"
check "popcnt alone is not enough"             "ssse3 sse4_1 sse4_2"                "$(cpu_missing_x86_64_v2 "$WORK/k10" x86_64)"
check "a name inside another flag is no match" "sse4_1 sse4_2 popcnt"               "$(cpu_missing_x86_64_v2 "$WORK/lookalike" x86_64)"
check "arm64 has no x86-64 level to miss"      ""                                   "$(cpu_missing_x86_64_v2 "$WORK/qemu64" aarch64)"
check "an unreadable cpuinfo is not a pass"    "pni ssse3 cx16 sse4_1 sse4_2 popcnt lahf_lm" "$(cpu_missing_x86_64_v2 "$WORK/absent" x86_64)"

echo "── bootstrap.sh: the preflight uses it and fails on it ──"
body=$(sed -n '/^run_preflight() {/,/^}/p' "$BOOTSTRAP")
has "$body" 'cpu_missing="$(cpu_missing_x86_64_v2)"' "run_preflight calls the helper"
has "$(grep -A3 'if \[\[ -n "\$cpu_missing" \]\]' <<<"$body")" "fatal=1" "…and a missing feature is fatal, before anything on the host changes"
main_order=$(grep -n -E '^  run_preflight$|^  guard_bootstrap_target$' "$BOOTSTRAP" | head -2 | cut -d: -f2 | tr -d ' ' | tr '\n' ' ')
check "the preflight runs for every mode and role, ahead of the mode guard" "run_preflight guard_bootstrap_target " "$main_order"

echo "── host-migration: the same check on upgrade ──"
# The migration reads /proc/cpuinfo and `uname -m`; run it as shipped with both
# replaced: `grep` and `uname` on PATH are wrappers that answer from the fake.
run_migration() { # run_migration <cpuinfo> <arch>
  local dir="$WORK/bin-$RANDOM"; mkdir -p "$dir"
  printf '#!/usr/bin/env bash\necho %q\n' "$2" > "$dir/uname"
  printf '#!/usr/bin/env bash\nargs=(); for a in "$@"; do [[ "$a" == /proc/cpuinfo ]] && a=%q; args+=("$a"); done\nexec /usr/bin/grep "${args[@]}"\n' "$1" > "$dir/grep"
  chmod +x "$dir/uname" "$dir/grep"
  PATH="$dir:$PATH" bash < "$MIGRATION" 2>&1
}
out=$(run_migration "$WORK/modern" x86_64); rc=$?
check "a current CPU passes" 0 "$rc"
out=$(run_migration "$WORK/qemu64" x86_64); rc=$?
check "qemu64 fails the migration (the upgrade stops before the services roll)" 1 "$rc"
has "$out" "missing: ssse3 sse4_1 sse4_2 popcnt" "…naming what is missing"
has "$out" "set the CPU type to 'host'" "…and what to do about it"
out=$(run_migration "$WORK/no-lahf" x86_64); rc=$?
check "a CPU also lacking lahf_lm fails the migration" 1 "$rc"
out=$(run_migration "$WORK/qemu64" aarch64); rc=$?
check "an arm64 node passes whatever its flags" 0 "$rc"
printf 'processor\t: 0\nmodel name\t: no flags line\n' > "$WORK/noflags"
out=$(run_migration "$WORK/noflags" x86_64); rc=$?
check "a cpuinfo without a flags line fails the migration" 1 "$rc"
has "$out" "has no 'flags' line" "…and says why, instead of ending without a word"
has "$(sed -n '1,8p' "$MIGRATION")" "# blocks-on-failure: yes" "the migration blocks on failure"
has "$(sed -n '1,8p' "$MIGRATION")" "# phase: before-services" "…and runs before the services roll"

echo "── the two flag lists agree ──"
list_of() { grep -o -E 'for f in [a-z0-9_ ]+; do' "$1" | head -1; }
check "bootstrap.sh and the migration check the same seven flags" "$(sed -n '/^cpu_missing_x86_64_v2() {/,/^}/p' "$BOOTSTRAP" | grep -o -E 'for f in [a-z0-9_ ]+; do')" "$(list_of "$MIGRATION")"

echo
echo "passed=$pass failed=$fail"
[[ $fail -eq 0 ]]
