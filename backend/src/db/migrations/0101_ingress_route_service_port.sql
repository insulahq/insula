-- Migration 0101: add service_port to ingress_routes
-- Allows per-route port selection for custom deployments with multiple exposed ports.
ALTER TABLE ingress_routes ADD COLUMN IF NOT EXISTS service_port INTEGER;
