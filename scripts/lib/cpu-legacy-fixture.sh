# shellcheck shell=bash
# cpu-legacy-fixture.sh — put a tenant into the shape of a tenant still on the
# OLD CPU reservation model, for the CPU-migration harnesses (ADR-062).
#
# New tenants are born on CPU shares, and "revert to legacy" is gone, so a
# harness can no longer get a legacy tenant from the API. But the migration
# from legacy is what the platform now runs unattended on every install
# (cpu-migration/auto-migrate.ts), so its edge cases still need a real legacy
# namespace to run against. This recreates one from a fresh tenant — the
# state the old revert restored:
#
#   tenants.cpu_scheduling_mode = legacy, no migration baselines;
#   no LimitRange; the quota's requests.cpu sized from cores, no limits.cpu;
#   each application back on a reservation-sized request, through the API so
#   its Deployment follows; pods recreated without the LimitRange's ceiling.
#
# It also HOLDS the automatic migrator's lease while a harness runs — the
# migrator would otherwise move the fixture back to shares mid-case. Call
# release_cpu_auto_migrate on exit (the harnesses trap it).
#
# Uses the calling script's helpers: psql, kc, A (curl args), API.

CPU_AUTO_MIGRATE_LEASE_KEY='scheduler-lease:cpu-auto-migrate'
CPU_AUTO_MIGRATE_HOLDER='e2e-cpu-harness'

hold_cpu_auto_migrate() {  # keeps the platform's migrator off for three hours — longer than any harness run
  psql "INSERT INTO platform_settings (setting_key, setting_value, updated_at)
        VALUES ('$CPU_AUTO_MIGRATE_LEASE_KEY', json_build_object('holder','$CPU_AUTO_MIGRATE_HOLDER','until', now() + interval '180 minutes')::text, now())
        ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = now();" >/dev/null
}

release_cpu_auto_migrate() {
  psql "DELETE FROM platform_settings WHERE setting_key = '$CPU_AUTO_MIGRATE_LEASE_KEY'
        AND setting_value::jsonb->>'holder' = '$CPU_AUTO_MIGRATE_HOLDER';" >/dev/null
}

make_legacy() {  # $1 tenant id  $2 namespace
  local tid=$1 ns=$2 cores n each id
  cores=$(psql "SELECT COALESCE(t.cpu_limit_override, p.cpu_limit) FROM tenants t JOIN hosting_plans p ON p.id = t.plan_id WHERE t.id = '$tid';")
  [ -n "$cores" ] || { echo "make_legacy: no cores for $tid" >&2; return 1; }
  psql "UPDATE tenants SET cpu_scheduling_mode = 'legacy', cpu_migrated_at = NULL WHERE id = '$tid';" >/dev/null
  psql "UPDATE deployments SET cpu_request_pre_migration = NULL WHERE tenant_id = '$tid';" >/dev/null
  kc "-n $ns delete limitrange --all" >/dev/null
  # Room for one rollout above the reservations; a case that needs the old
  # zero-slack shape tightens it itself.
  kc "-n $ns patch resourcequota $ns-quota --type=merge -p '{\"spec\":{\"hard\":{\"limits.cpu\":null,\"requests.cpu\":\"$(python3 -c "print(round(float('$cores') * 2, 2))")\"}}}'" >/dev/null
  n=$(psql "SELECT count(*) FROM deployments WHERE tenant_id = '$tid' AND status <> 'deleted';")
  if [ "${n:-0}" -gt 0 ]; then
    each=$(python3 -c "print(max(0.01, int(float('$cores') * 100 / $n) / 100))")
    for id in $(psql "SELECT id FROM deployments WHERE tenant_id = '$tid' AND status <> 'deleted';"); do
      local code
      code=$(curl "${A[@]}" -o /dev/null -w '%{http_code}' -X PATCH "$API/api/v1/tenants/$tid/deployments/$id/resources" -d "{\"cpu_request\":\"$each\"}")
      # Say so: a fixture that silently kept the tier-sized request is not a
      # legacy tenant, and every case would then test something else.
      [ "$code" = "200" ] || { echo "make_legacy: resizing deployment $id answered $code" >&2; return 1; }
    done
  fi
  kc "-n $ns delete pods --all --wait=false" >/dev/null
}
