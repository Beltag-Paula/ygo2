FROM node:26-slim

WORKDIR /app

# git is only needed at build time (to fetch CardScripts + BabelCDB); dumb-init at runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# dependencies first so rebuilds stay fast when only code changes
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# engine data (card scripts + card database), then drop git to keep the image small
RUN npm run setup \
    && rm -rf CardScripts/.git BabelCDB/.git \
    && apt-get purge -y git && apt-get autoremove -y

# accounts, decks and stats live in SQLite here. Mount a volume on it or they vanish with the container.
ENV NODE_ENV=production \
    PORT=3000 \
    TRUST_PROXY=1 \
    DB_PATH=/app/data/ygo.db

RUN mkdir -p /app/data /app/pics && chown -R node:node /app/data /app/pics
VOLUME ["/app/data", "/app/pics"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]