/**
 * stalwart-cli version + sha256 pin shared by every Job that runs the
 * cli inside the cluster (throttle-override Job/CronJob, future).
 *
 * Bumping these is a coordinated change: also update the matching pins
 * in k8s/overlays/development/stalwart-throttle-override-job.yaml and
 * k8s/base/stalwart-mail/stalwart/bootstrap-job.yaml.
 */
export const STALWART_CLI_VERSION = 'v1.0.4';
export const STALWART_CLI_SHA256 = '01c734752cc44b9e24f753cbacfc2d489dadaaccf72cd229ecb7269e85e0eefa';
export const STALWART_CLI_DOWNLOAD_URL =
  `https://github.com/stalwartlabs/cli/releases/download/${STALWART_CLI_VERSION}/stalwart-cli-x86_64-unknown-linux-musl.tar.xz`;
