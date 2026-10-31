import http from "node:http";
import { pathToFileURL } from "node:url";
import { ENV } from "./config/env.ts";
import {
  concurrencyGuard,
  sanitizeUserMessage,
} from "./middleware/rate-limiter.ts";
import { ragEngine, type FaqEntry } from "./rag/engine.ts";
import { streamSalesChatResponse, type ChatTurn } from "./agent/sales-agent.ts";
import {
  getLeadStats,
  getRecentLeads,
  saveLeadToDb,
} from "./services/db.ts";
import { checkDistributedRateLimitInSupabase } from "./services/supabase.ts";
import { webhookQueue } from "./services/webhook-queue.ts";

function setCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse) {
  const origin = req.headers.origin || "*";
  const allowOrigin =
    ENV.ALLOWED_ORIGINS.includes("*") || ENV.ALLOWED_ORIGINS.includes(origin)
      ? origin
      : ENV.ALLOWED_ORIGINS[0] || "*";

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Session-Id"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown
) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody<T>(
  req: http.IncomingMessage,
  maxBytes = 64 * 1024
): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("Payload too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve((raw ? JSON.parse(raw) : {}) as T);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

function getClientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "127.0.0.1";
}

export async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const matchedPath =
    (typeof req.headers["x-matched-path"] === "string" && req.headers["x-matched-path"]) ||
    (typeof req.headers["x-forwarded-url"] === "string" && req.headers["x-forwarded-url"]) ||
    (typeof req.headers["x-invoke-path"] === "string" && req.headers["x-invoke-path"]) ||
    req.url ||
    "/";
  const url = new URL(matchedPath, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // 0. Root Welcome / Status Page
  if (req.method === "GET" && (pathname === "/" || pathname === "")) {
    const isHtml = (req.headers.accept || "").includes("text/html");
    if (isHtml) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>The Eastern Chambers — AI Sales Concierge Backend</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b1a15; color: #f2ede4; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: #122820; border: 1px solid #c9a96e; border-radius: 12px; padding: 32px; max-width: 580px; width: 100%; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    h1 { color: #c9a96e; font-size: 22px; margin-top: 0; margin-bottom: 8px; }
    .badge { display: inline-flex; align-items: center; gap: 6px; background: #1a4234; color: #7fe3b5; padding: 4px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; margin-bottom: 16px; }
    .badge::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #7fe3b5; }
    p { line-height: 1.6; color: #d0d7d3; font-size: 14px; }
    .endpoints { background: #091511; padding: 16px; border-radius: 8px; font-family: ui-monospace, Menlo, Monaco, monospace; font-size: 12px; margin: 20px 0; border: 1px solid #1a4234; }
    .endpoints div { margin: 8px 0; color: #e2d5be; }
    .endpoints span { color: #c9a96e; font-weight: bold; }
    .footer { font-size: 12px; color: #889988; margin-top: 20px; border-top: 1px solid #1a4234; padding-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">Operational</div>
    <h1>The Eastern Chambers</h1>
    <p>AI Sales Concierge backend is online with hybrid vector & BM25 retrieval, Supabase cloud persistence, and high-concurrency streaming.</p>
    <div class="endpoints">
      <div><span>POST</span> /api/chat — Streaming SSE chat endpoint</div>
      <div><span>GET</span>  /api/health — System health & concurrency metrics</div>
      <div><span>POST</span> /api/leads — Register commercial sales lead</div>
      <div><span>GET</span>  /api/leads — Retrieve recent leads (Protected)</div>
    </div>
    <div class="footer">LBS Marg, Vikhroli West, Mumbai &bull; MahaRERA: P51800054892</div>
  </div>
</body>
</html>`);
      return;
    }

    sendJson(res, 200, {
      service: "The Eastern Chambers — AI Sales Concierge Backend",
      status: "online",
      endpoints: {
        chat: "POST /api/chat",
        health: "GET /api/health",
        leads: "POST /api/leads",
      },
      rag: ragEngine.getStatus(),
    });
    return;
  }

  // 1. Health & Concurrency Status Endpoint
  if (req.method === "GET" && (pathname === "/health" || pathname === "/api/health")) {
    sendJson(res, 200, {
      status: "ok",
      service: "tec-chatbot-backend",
      timestamp: new Date().toISOString(),
      concurrency: concurrencyGuard.getMetrics(),
      rag: ragEngine.getStatus(),
      leads: {
        ...getLeadStats(),
        pendingWebhookQueue: webhookQueue.getPendingCount(),
      },
    });
    return;
  }

  // 2. Streaming RAG Chat Endpoint (SSE)
  if (req.method === "POST" && pathname === "/api/chat") {
    const clientIp = getClientIp(req);

    let body: {
      sessionId?: string;
      message?: string;
      history?: ChatTurn[];
    };

    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, {
        error: err instanceof Error ? err.message : "Bad request",
      });
      return;
    }

    const sessionId = String(body.sessionId || clientIp).slice(0, 80);
    const rateKey = `${clientIp}:${sessionId}`;

    // Use Distributed Supabase Rate Limiter across instances when deployed, with in-memory fallback
    const distributedRate = ENV.SUPABASE_ENABLED
      ? await checkDistributedRateLimitInSupabase({
          key: rateKey,
          windowSeconds: Math.ceil(ENV.RATE_LIMIT_WINDOW_MS / 1000),
          maxRequests: ENV.RATE_LIMIT_MAX_MESSAGES_PER_IP,
        })
      : null;

    const rateCheck = distributedRate || concurrencyGuard.checkRateLimit(rateKey);
    if (!rateCheck.allowed) {
      sendJson(res, 429, {
        error: `Rate limit reached. Please wait ${rateCheck.retryAfterSeconds}s before sending another message.`,
      });
      return;
    }

    const cleanMessage = sanitizeUserMessage(body.message);
    if (!cleanMessage) {
      sendJson(res, 400, { error: "Please enter a valid message." });
      return;
    }

    if (!concurrencyGuard.acquireStreamSlot()) {
      sendJson(res, 503, {
        error:
          "All sales concierge lines are currently at peak capacity. Please try again in a moment.",
      });
      return;
    }

    // Set up Server-Sent Events (SSE) headers for real-time streaming
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let streamClosed = false;
    let slotReleased = false;
    const releaseSlotOnce = () => {
      if (!slotReleased) {
        slotReleased = true;
        concurrencyGuard.releaseStreamSlot();
      }
    };

    req.on("close", () => {
      streamClosed = true;
      releaseSlotOnce();
    });

    const sendSseEvent = (event: string, data: unknown) => {
      if (streamClosed || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const safeHistory: ChatTurn[] = Array.isArray(body.history)
      ? body.history
          .filter(
            (h) =>
              h &&
              (h.role === "user" || h.role === "assistant") &&
              typeof h.content === "string"
          )
          .slice(-10)
      : [];

    try {
      await streamSalesChatResponse({
        sessionId,
        userMessage: cleanMessage,
        history: safeHistory,
        clientIp,
        callbacks: {
          onSources: (sources) => {
            sendSseEvent("sources", { sources });
          },
          onToken: (token) => {
            sendSseEvent("token", { token });
          },
          onLeadCaptured: (lead) => {
            sendSseEvent("lead_captured", {
              id: lead.id,
              name: lead.name,
              phone: lead.phone.replace(/^'/, ""),
            });
          },
          onDone: () => {
            sendSseEvent("done", { ok: true });
            if (!res.writableEnded) res.end();
            releaseSlotOnce();
          },
          onError: (errMsg) => {
            sendSseEvent("error", { error: errMsg });
            if (!res.writableEnded) res.end();
            releaseSlotOnce();
          },
        },
      });
    } catch {
      if (!res.writableEnded) res.end();
      releaseSlotOnce();
    }
    return;
  }

  // 3. Direct Lead Submission Endpoint (Used by Quick-Callback Card in Chat Widget)
  if (req.method === "POST" && pathname === "/api/leads") {
    const clientIp = getClientIp(req);
    try {
      const body = await readJsonBody<{
        sessionId?: string;
        name?: string;
        phone?: string;
        areaRequired?: string;
        budget?: string;
        additionalEnquiry?: string;
      }>(req);

      const name = String(body.name || "").trim();
      const phone = String(body.phone || "").trim();
      const phoneDigits = phone.replace(/\D/g, "");

      if (name.length < 2) {
        sendJson(res, 400, {
          success: false,
          error: "Please enter your name (at least 2 characters).",
        });
        return;
      }

      if (phoneDigits.length < 7 || phoneDigits.length > 15) {
        sendJson(res, 400, {
          success: false,
          error: "Please enter a valid contact phone number.",
        });
        return;
      }

      const lead = saveLeadToDb({
        sessionId: body.sessionId || clientIp,
        name,
        phone,
        areaRequired: body.areaRequired || "",
        budget: body.budget || "",
        additionalEnquiry: body.additionalEnquiry || "Requested callback via Sales Chatbot",
        source: "chat_form",
        clientIp,
      });

      webhookQueue.enqueue(lead);

      sendJson(res, 200, {
        success: true,
        lead: {
          id: lead.id,
          name: lead.name,
          phone: lead.phone,
          createdAt: lead.createdAt,
        },
      });
    } catch (err) {
      sendJson(res, 400, {
        success: false,
        error: err instanceof Error ? err.message : "Failed to save lead.",
      });
    }
    return;
  }

  // 4. Get Recent Leads Summary (Protected - Secret Token Required)
  if (req.method === "GET" && pathname === "/api/leads") {
    const authHeader = req.headers.authorization || "";
    const secretHeader = req.headers["x-enquiry-secret"] || "";
    const providedToken = authHeader.replace(/^Bearer\s+/i, "") || secretHeader;

    if (providedToken !== ENV.ENQUIRY_SECRET_TOKEN) {
      sendJson(res, 401, {
        error: "Unauthorized: Access to client leads is strictly restricted.",
      });
      return;
    }

    const recent = await getRecentLeads(20);
    sendJson(res, 200, {
      stats: getLeadStats(),
      pendingQueue: webhookQueue.getPendingCount(),
      recent,
    });
    return;
  }

  // 5. Get or Add FAQs Dynamically (Drop-in FAQ Management)
  if (req.method === "GET" && pathname === "/api/faqs") {
    sendJson(res, 200, {
      count: ragEngine.getFaqs().length,
      faqs: ragEngine.getFaqs(),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/faqs") {
    try {
      const body = await readJsonBody<FaqEntry>(req);
      if (!body.question || !body.answer) {
        sendJson(res, 400, {
          error: "Both 'question' and 'answer' fields are required.",
        });
        return;
      }
      const faq: FaqEntry = {
        id:
          body.id ||
          `faq-${body.question
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, 32)}`,
        category: body.category || "General FAQ",
        question: body.question.trim(),
        answer: body.answer.trim(),
        tags: Array.isArray(body.tags) ? body.tags : [],
      };
      const updated = await ragEngine.upsertFaq(faq);
      sendJson(res, 200, {
        success: true,
        message: "FAQ indexed into RAG knowledge base.",
        totalFaqs: updated.length,
        faq,
      });
    } catch (err) {
      sendJson(res, 400, {
        error: err instanceof Error ? err.message : "Failed to add FAQ",
      });
    }
    return;
  }

  // 6. Hot-Reload RAG Knowledge Index
  if (req.method === "POST" && pathname === "/api/rag/reload") {
    const status = await ragEngine.reloadIndex();
    sendJson(res, 200, {
      success: true,
      message: "RAG knowledge base re-indexed.",
      rag: status,
    });
    return;
  }

  sendJson(res, 404, { error: "Endpoint not found" });
}

async function bootstrap() {
  await ragEngine.initialize();
  const ragStatus = ragEngine.getStatus();

  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  // Tune TCP server for 500+ concurrent keep-alive SSE streams
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.maxConnections = 2000;

  server.listen(ENV.PORT, ENV.HOST, () => {
    console.log("==================================================================");
    console.log("🏛️  THE EASTERN CHAMBERS — AI RAG SALES BACKEND ONLINE");
    console.log(`🌐 Server URL           : http://${ENV.HOST === "0.0.0.0" ? "127.0.0.1" : ENV.HOST}:${ENV.PORT}`);
    console.log(`🗄️  Cloud Database       : ${ENV.SUPABASE_ENABLED ? "Supabase Connected (PostgreSQL + pgvector)" : "Local SQLite WAL (Add SUPABASE_URL in .env for Cloud DB)"}`);
    console.log(`📚 RAG Knowledge Chunks : ${ragStatus.chunkCount} chunks (${ragStatus.faqCount} FAQs)`);
    console.log(`🧠 OpenAI Mode          : ${ragStatus.openAiConfigured ? `Connected (${ENV.OPENAI_CHAT_MODEL} + ${ENV.OPENAI_EMBEDDING_MODEL})` : "Grounded Hybrid BM25 Mode (Add OPENAI_API_KEY in .env to enable GPT-4o-mini)"}`);
    console.log(`⚡ Max Concurrent Users : ${ENV.MAX_CONCURRENT_STREAMS} simultaneous streams`);
    console.log("==================================================================");
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void bootstrap();
}

/**
 * Default export required by Vercel Serverless Functions
 * Invoked automatically for incoming HTTP requests on Vercel deployments.
 */
export default async function handler(
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  await ragEngine.initialize();
  await handleRequest(req, res);
}

