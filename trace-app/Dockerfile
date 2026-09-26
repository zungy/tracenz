FROM node:24-bookworm-slim
ENV NODE_ENV=production TRACE_MODE=supabase HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node desktop/bridge.cjs desktop/backend-url.cjs ./desktop/
COPY --chown=node:node public ./public
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
