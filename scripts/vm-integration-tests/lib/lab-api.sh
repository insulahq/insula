#!/usr/bin/env bash
# scripts/vm-integration-tests/lib/lab-api.sh — a lab cluster's admin API, called the way
# the operator's browser calls it: through the cluster's ingress, TLS verified against the
# lab CA, signed in as the lab admin. The bearer token lives in a 0600 header file in the
# run's private scratch directory (VMTEST_TMP_DIR) — never on a command line.
#
# Uses the CL_* settings of lab_cluster_def.

# lab_api_login — sign in as admin@<cluster apex>; sets the LAB_API_* used by lab_api.
lab_api_login() {
  local host pw tok
  read -r _ host <<<"${CL_NODES[0]}"
  LAB_API_BASE="https://admin.${CL_APEX}/api/v1"
  # The LAN resolver may not know the lab's names; the first server's ingress does.
  LAB_API_RESOLVE="admin.${CL_APEX}:443:${CL_PREFIX}.${host}"
  LAB_API_CA="${VMTEST_TMP_DIR}/lab-ca.pem"
  LAB_API_AUTH="${VMTEST_TMP_DIR}/lab-api-auth-${CL_NAME}"
  lab_ca_root > "$LAB_API_CA" || true
  [[ -s "$LAB_API_CA" ]] || { echo "lab: no CA root from the services VM" >&2; return 1; }
  pw="$(lab_state_secret "LAB_${CL_NAME^^}_ADMIN_PASSWORD" 24)"
  # The password travels on stdin.
  tok="$(jq -nc --arg e "admin@${CL_APEX}" --arg p "$pw" '{email: $e, password: $p}' \
    | curl -sS --cacert "$LAB_API_CA" --resolve "$LAB_API_RESOLVE" -H 'Content-Type: application/json' \
        --data-binary @- "${LAB_API_BASE}/auth/login" | jq -r '.data.token // empty')" || true
  [[ -n "$tok" ]] || { echo "lab: sign-in as admin@${CL_APEX} failed" >&2; return 1; }
  ( umask 077; printf 'Authorization: Bearer %s\n' "$tok" > "$LAB_API_AUTH" )
}

# lab_api <METHOD> <path> [json-body] — the response body on stdout. A non-2xx answer
# prints the status and the start of the body on stderr and returns 1.
lab_api() {
  local method="$1" path="$2" body="${3:-}" out code args=()
  out="$(mktemp "${VMTEST_TMP_DIR}/api.XXXXXX")"
  [[ -z "$body" ]] || args=(-H 'Content-Type: application/json' --data-binary "$body")
  code="$(curl -sS -o "$out" -w '%{http_code}' --cacert "$LAB_API_CA" --resolve "$LAB_API_RESOLVE" \
      -X "$method" -H @"$LAB_API_AUTH" ${args[@]+"${args[@]}"} "${LAB_API_BASE}${path}")" \
    || { rm -f "$out"; echo "lab: ${method} ${path}: no answer" >&2; return 1; }
  if [[ "$code" == 2* ]]; then cat "$out"; rm -f "$out"; return 0; fi
  echo "lab: ${method} ${path} → HTTP ${code}: $(head -c 400 "$out")" >&2
  rm -f "$out"
  return 1
}
