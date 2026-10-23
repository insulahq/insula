import type { FastifyCompressOptions } from '@fastify/compress';

/**
 * Responses are compressed as before (br, gzip, deflate). Request bodies are
 * decoded from gzip or deflate only. Decoding runs in preParsing, so on a
 * route that needs no login (the login form among them) or checks it in
 * preHandler, every decoder listed here is reachable by anyone who can reach
 * the API. Brotli is left out because Node's Brotli decoder could be driven
 * into an out-of-bounds write by a crafted stream (CVE-2026-111497), and zstd
 * because Node 22 still marks its decoder experimental. Nothing the platform
 * ships sends a compressed request body; a request using either is refused
 * with 415 and never decoded.
 */
export const COMPRESS_OPTIONS: FastifyCompressOptions = {
  global: true,
  requestEncodings: ['gzip', 'deflate', 'identity'],
};
