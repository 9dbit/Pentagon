FROM node:20.18.1-bookworm-slim

WORKDIR /app

ENV NODE_ENV=development
ENV NPM_CONFIG_PRODUCTION=false

COPY package.json package-lock.json ./
RUN npm install --include=dev --no-audit --no-fund

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV NPM_CONFIG_PRODUCTION=true
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "run", "start"]
