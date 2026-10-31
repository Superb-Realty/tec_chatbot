import type http from "node:http";
import { ragEngine } from "../src/rag/engine.ts";
import { handleRequest } from "../src/server.ts";

/**
 * Vercel Serverless Function Entrypoint
 * Automatically initializes the RAG engine once per warm instance
 * and delegates all HTTP / Streaming SSE routes to `handleRequest`.
 */
export default async function vercelHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  await ragEngine.initialize();
  await handleRequest(req, res);
}

