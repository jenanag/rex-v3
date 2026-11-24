FROM node:26.13.1-bookworm-slim AS build
WORKDIR /tool
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src/ src/
COPY scripts/ scripts/
COPY contract/ contract/
RUN --network=none npm run build && npm prune --omit=dev --offline

FROM node:26.13.1-bookworm-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /tool
COPY --from=build --chown=node:node /tool/dist dist
COPY --from=build --chown=node:node /tool/node_modules node_modules
COPY --from=build --chown=node:node /tool/package.json package.json
USER node
EXPOSE 8080
HEALTHCHECK --interval=3s --timeout=2s --start-period=3s CMD node -e 'fetch("http://127.0.0.1:"+process.env.PORT+"/healthz").then(r=>{if(!r.ok)process.exitCode=1}).catch(()=>{process.exitCode=1})'
CMD ["node", "dist/src/server.js"]
