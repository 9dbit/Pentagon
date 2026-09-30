FROM node:20.18.1-bookworm-slim

WORKDIR /app

ENV NODE_ENV=development

COPY package.json package-lock.json ./
RUN corepack enable \
  && corepack prepare pnpm@9.15.4 --activate \
  && pnpm import \
  && pnpm install --prod=false --no-frozen-lockfile

COPY . .
RUN pnpm run build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "run", "start"]
