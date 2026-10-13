FROM ghcr.io/puppeteer/puppeteer:24.0.0
USER root
WORKDIR /app
COPY package.json ./
RUN npm install
COPY server.js ./
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
