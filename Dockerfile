FROM node:22-alpine AS sdk
ARG STATEWEAVE_SDK_REF=68bef8d1d10ffaee2a629a7a65c6f21f1e030cd2
RUN apk add --no-cache git && corepack enable
RUN git clone https://github.com/stateweave/sdk-typescript.git /sdk \
    && cd /sdk \
    && git checkout "$STATEWEAVE_SDK_REF"
WORKDIR /sdk
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/stateweave-package.json ./.stateweave-sdk/package.json
COPY --from=sdk /sdk/dist ./.stateweave-sdk/dist
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/.stateweave-sdk ./.stateweave-sdk
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
