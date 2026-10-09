-- ADR-064 §8: an upgrade run may also take the cluster's Kubernetes (k3s) to the
-- release's pin, as an opt-in fourth step after the host changes finish. The
-- target is recorded on the run; the step joins the allowed steps.
ALTER TABLE "platform_upgrade_runs" ADD COLUMN IF NOT EXISTS "kubernetes_version" text;

ALTER TABLE "platform_upgrade_runs" DROP CONSTRAINT IF EXISTS "platform_upgrade_runs_step_check";
-- safety-reviewed: the new CHECK only WIDENS the allowed steps (adds
-- 'upgrade-kubernetes'), so every existing row — which passed the previous
-- CHECK — passes this one, so validating them cannot fail.
ALTER TABLE "platform_upgrade_runs" ADD CONSTRAINT "platform_upgrade_runs_step_check"
  CHECK ("step" IN ('prepare-nodes', 'update-services', 'finish', 'upgrade-kubernetes', 'done'));
