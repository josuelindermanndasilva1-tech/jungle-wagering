FROM oven/bun:1.3.14
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "src/main.ts"]
