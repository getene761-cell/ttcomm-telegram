FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src

RUN mkdir -p /app/data && chown -R node:node /app
USER node

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
