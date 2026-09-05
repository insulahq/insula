/**
 * stalwart-cli version + sha256 pin shared by every Job that runs the
 * cli inside the cluster (throttle-override Job/CronJob, future).
 *
 * Bumping these is a coordinated change: the matching pins live in
 * k8s/overlays/development/stalwart-throttle-override-job.yaml, which
 * verifies the archive against CLI_SHA256 and exits 1 on a mismatch — so a
 * version bumped without its hash fails the Job rather than running an
 * unverified binary. Recompute with:
 *   curl -sL <download url> | sha256sum
 * (This note used to also name bootstrap-job.yaml, which carries no CLI pin.)
 */
export const STALWART_CLI_VERSION = 'v1.0.12';
export const STALWART_CLI_SHA256 = '76fcd7250a10c7bee704dc4a08000b3faca6b5a22895d41831c0c37efd95acce';
export const STALWART_CLI_DOWNLOAD_URL =
  `https://github.com/stalwartlabs/cli/releases/download/${STALWART_CLI_VERSION}/stalwart-cli-x86_64-unknown-linux-musl.tar.xz`;
