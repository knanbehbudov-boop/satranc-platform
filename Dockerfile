# Satranç Turnuva Platformu — uygulama imajı.
# Harici npm bağımlılığı yoktur; Node 22.18+ TypeScript dosyalarını doğrudan çalıştırır.
FROM node:22-alpine

# Stockfish: bot rakip ve adil oyun analizi için (üretimde zorunlu, K33). Alpine community deposundan.
RUN apk add --no-cache stockfish || echo 'uyarı: stockfish paketi kurulamadı; geliştirmede yerleşik motor kullanılır'

WORKDIR /app
COPY package.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts

# Çalışma alanı paketini bağla (npm install'ın yaptığı tek iş) ve web paketini üret.
RUN mkdir -p node_modules/@satranc \
 && ln -s ../../packages/chess-core node_modules/@satranc/chess-core \
 && node scripts/build-web.mjs

ENV HOST=0.0.0.0 PORT=8080 STOCKFISH_PATH=/usr/bin/stockfish
EXPOSE 8080
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "packages/server/src/main.ts"]
