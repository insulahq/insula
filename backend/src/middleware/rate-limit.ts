import type { FastifyInstance } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { ApiError } from '../shared/errors.js';

interface RateLimitOptions {
  max?: number;
  timeWindow?: string;
}

export async function registerRateLimit(
  app: FastifyInstance,
  options?: RateLimitOptions,
): Promise<void> {
  if (process.env.DISABLE_RATE_LIMIT === 'true') {
    app.log.info('Rate limiting disabled via DISABLE_RATE_LIMIT env var');
    return;
  }

  await app.register(fastifyRateLimit, {
    max: options?.max ?? 100,
    timeWindow: options?.timeWindow ?? '1 minute',
    keyGenerator: (request) => {
      // Use authenticated user ID if available, otherwise IP
      const user = (request as unknown as { user?: { sub: string } }).user;
      return user?.sub ?? request.ip;
    },
    /**
     * Return an `ApiError`, not a plain object.
     *
     * @fastify/rate-limit does `throw params.errorResponseBuilder(...)`, so
     * whatever this returns is thrown and lands in `errorHandler`. The
     * previous version returned a hand-rolled `{statusCode, error:{code,...}}`
     * literal — which is the shape of a RESPONSE, not of a throwable. The
     * handler looked for a top-level `.code` and `.message`, found neither
     * (they were nested under `.error`), and fell through to its generic 4xx
     * branch, emitting:
     *
     *     {"code":"BAD_REQUEST","status":429,"message":undefined}
     *
     * So an operator being throttled was told they had sent a bad request,
     * with no retry hint and a blank message — and the carefully written
     * remediation below had never once reached a client.
     *
     * `ApiError` is the platform's own throwable and `errorHandler` matches it
     * FIRST, preserving code, message, status, details and remediation intact.
     *
     * The plugin sets Retry-After and the X-RateLimit-* headers before it
     * throws, so header and body now agree.
     */
    errorResponseBuilder: (_request, context) => {
      const retryAfterSeconds = Math.max(1, Math.ceil(context.ttl / 1000));
      return new ApiError(
        'RATE_LIMIT_EXCEEDED',
        `Too many requests. Please retry after ${retryAfterSeconds} seconds`,
        // Honour the plugin's status rather than hardcoding 429: with `ban`
        // configured it raises 403 instead, and hardcoding would mislabel it.
        context.statusCode ?? 429,
        { retry_after: retryAfterSeconds, limit: context.max },
        'Wait for the retry_after window, then retry with exponential backoff.',
      );
    },
  });
}
