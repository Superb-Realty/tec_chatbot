import type http from "node:http";
import { ragEngine } from "../src/rag/engine.ts";
import { handleRequest } from "../src/server.ts";

let isInitialized = false;
let initPromise: Promise<void> | null = null;

async function ensureInitialized(): Promise<void> {
  if (isInitialized) return;
  if (!initPromise) {
    initPromise = ragEngine
      .initialize()
      .then(() => {
        isInitialized = true;
      })
      .catch((err) => {
        console.error("[Vercel] RAG initialization warning:", err);
        // Do not crash the lambda invocation; allow requests to proceed
        isInitialized = true;
      });
  }
  await initPromise;
}

/**
 * Vercel Serverless Function Entrypoint
 * Robustly catches any top-level execution errors to prevent 500 FUNCTION_INVOCATION_FAILED.
 */
export default async function vercelHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  try {
    await ensureInitialized();
    await handleRequest(req, res);
  } catch (err) {
    console.error("[Vercel] Unhandled handler error:", err);
    if (!res.headersSent) {
      res.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(
        JSON.stringify({
          error: "Internal Server Error",
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        })
      );
    }
  }
}
