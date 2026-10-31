FROM node:24-alpine

WORKDIR /app

# Copy package metadata
COPY package.json tsconfig.json ./

# Copy source code and RAG knowledge base
COPY src ./src
COPY knowledge ./knowledge

# Create persistent data directory for SQLite WAL database & cached vector embeddings
RUN mkdir -p /app/data

EXPOSE 4000

ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0

CMD ["node", "--no-warnings", "src/server.ts"]

