FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json server.mjs client-server.mjs client-store.mjs workspace.mjs evidence.mjs manage.mjs ./
COPY --chown=node:node dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173 TALENTLENS_DATA_DIR=/app/data
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:4173/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server.mjs"]
