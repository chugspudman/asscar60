FROM node:24-slim

WORKDIR /app

COPY package.json ./
COPY *.mjs ./
COPY index.html styles.css ./
COPY assets ./assets

RUN mkdir -p /data

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173
ENV ASSCAR_DB_PATH=/data/asscar60.sqlite

EXPOSE 4173

CMD ["node", "server.mjs"]
