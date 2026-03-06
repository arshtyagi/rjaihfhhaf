FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --production
RUN npx playwright install chromium

COPY src/ ./src/

# Profile dir for persistent Chromium session (mount as volume)
RUN mkdir -p /data/browser-profile

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]
