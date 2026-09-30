FROM node:20.18.1-bookworm-slim

WORKDIR /app

ENV NODE_ENV=development

COPY package.json package-lock.json ./
RUN npm install -g npm@10.9.2 \
  && env -u NPM_CONFIG_PRODUCTION -u NODE_ENV npm install --include=dev --no-audit --no-fund

COPY . .
RUN env -u NPM_CONFIG_PRODUCTION NODE_ENV=development npm run build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "run", "start"]
