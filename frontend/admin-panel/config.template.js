// Injected at container startup by docker-entrypoint.sh via envsubst.
window.__RUNTIME_CONFIG__ = {
  API_URL: "${API_URL}",
  TENANT_PANEL_URL: "${TENANT_PANEL_URL}",
  STALWART_ADMIN_URL: "${STALWART_ADMIN_URL}",
  LONGHORN_URL: "${LONGHORN_URL}",
};
