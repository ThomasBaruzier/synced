FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./

RUN npm install --omit=dev && \
    npm cache clean --force

COPY --chown=node:node . .

RUN mkdir -p uploads && \
    chown node:node uploads

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
