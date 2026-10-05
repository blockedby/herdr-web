FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY auth.mjs server.mjs ./
USER node
CMD ["node", "server.mjs"]
