FROM nginx:1.30-alpine@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46

RUN adduser -D -u 1000 webuser

# Remove default config
RUN rm /etc/nginx/conf.d/default.conf

COPY nginx.conf /etc/nginx/conf.d/default.conf

RUN mkdir -p /var/www/html && chown -R webuser:webuser /var/www/html
WORKDIR /var/www/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://localhost/health || exit 1
