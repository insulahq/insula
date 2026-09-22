// Global test setup
// Sets default env vars for tests

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-key-for-testing-only';
process.env.DATABASE_URL ??= 'postgresql://platform:platform@localhost:5432/platform_test';
process.env.PORT = '0'; // random port for tests

// Passkey config is read straight from process.env by loadPasskeyConfig(), so
// it bypasses the config object buildTestApp() passes to buildApp(). Without
// these, registering passkeyRoutes THROWS and every suite that builds the app
// dies in beforeAll — which vitest reports as "skipped" tests, not failures.
// Test-only values; `??=` keeps a real environment in control.
process.env.PLATFORM_PASSKEY_RP_ID ??= 'example.test';
process.env.PLATFORM_PASSKEY_ORIGINS ??=
  'https://admin.example.test,https://tenant.example.test';

// Same story, with two DIFFERENT validators to satisfy: mtlsProvidersRoutes
// wants >=32 characters, tenant-bundles wants 32 BYTES of hex (64 chars). A
// 64-char hex string is the only shape that passes both. Deterministic dummy —
// it exists so the app can boot; no test decrypts real data with it.
process.env.PLATFORM_ENCRYPTION_KEY ??=
  '0'.repeat(64);
