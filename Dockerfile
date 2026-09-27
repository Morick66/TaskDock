FROM node:24-slim AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web ./web
COPY shared ./shared
RUN npm run build:web

FROM node:24-slim
ENV NODE_ENV=production \
    TASKDOCK_HOST=0.0.0.0 \
    TASKDOCK_PORT=47823 \
    TASKDOCK_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY skills ./skills
COPY --from=web-build /app/dist/web ./dist/web
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 47823
CMD ["node", "server/taskdock-server.mjs"]
