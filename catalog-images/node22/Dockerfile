FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

RUN mkdir -p /app && chown node:node /app
WORKDIR /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
