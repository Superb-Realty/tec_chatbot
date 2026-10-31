import { EventEmitter } from "node:events";
import type http from "node:http";
import { ragEngine } from "../rag/engine.ts";
import { handleRequest } from "../server.ts";
import { concurrencyGuard } from "../middleware/rate-limiter.ts";
import { clearTestLeads, getLeadStats } from "../services/db.ts";

const CONCURRENT_USERS = 500;

const SAMPLE_QUESTIONS = [
  "Where is The Eastern Chambers located and how far is the metro?",
  "Is the project MahaRERA registered? What is the RERA number?",
  "What certifications does the building have? Is it LEED Gold?",
  "Who are the developers behind The Eastern Chambers?",
  "Tell me about the rooftop amenities and the 10,000 sq ft green reserve.",
  "How many elevators are there and are the floor plates column-free?",
  "How far is CSMIA T2 international airport and BKC from Vikhroli?",
  "My name is Vikram Singhania and my phone is +91 98200 12345, please send floor plans.",
];

interface UserResult {
  userId: number;
  ok: boolean;
  statusCode: number;
  ttfbMs: number;
  totalMs: number;
  tokensReceived: number;
  leadCaptured: boolean;
  error?: string;
}

async function simulateSingleUserInMemory(userId: number): Promise<UserResult> {
  const question = SAMPLE_QUESTIONS[userId % SAMPLE_QUESTIONS.length];
  const sessionId = `loadtest_session_${userId}_${Date.now()}`;
  const fakeIp = `10.24.${Math.floor(userId / 250)}.${(userId % 250) + 1}`;
  const start = performance.now();
  let ttfbMs = 0;
  let tokensReceived = 0;
  let leadCaptured = false;
  let statusCode = 200;

  const payload = Buffer.from(
    JSON.stringify({
      sessionId,
      message: question,
      history: [],
    }),
    "utf-8"
  );

  return new Promise<UserResult>((resolve) => {
    const reqEmitter = new EventEmitter() as unknown as http.IncomingMessage;
    Object.assign(reqEmitter, {
      method: "POST",
      url: "/api/chat",
      headers: {
        host: "127.0.0.1:4000",
        "content-type": "application/json",
        "x-forwarded-for": fakeIp,
      },
      socket: { remoteAddress: fakeIp },
      destroy: () => {},
    });

    const resEmitter = new EventEmitter() as unknown as http.ServerResponse;
    Object.assign(resEmitter, {
      writableEnded: false,
      setHeader: () => {},
      writeHead: (code: number) => {
        statusCode = code;
      },
      write: (chunk: string | Buffer) => {
        if (ttfbMs === 0) {
          ttfbMs = performance.now() - start;
        }
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        const tokenMatches = text.match(/event:\s*token/g);
        if (tokenMatches) {
          tokensReceived += tokenMatches.length;
        }
        if (text.includes("event: lead_captured")) {
          leadCaptured = true;
        }
        return true;
      },
      end: (chunk?: string | Buffer) => {
        if (chunk) {
          (resEmitter as unknown as { write: (c: string | Buffer) => void }).write(chunk);
        }
        (resEmitter as unknown as { writableEnded: boolean }).writableEnded = true;
        reqEmitter.emit("close");
        resolve({
          userId,
          ok: statusCode === 200 && tokensReceived > 0,
          statusCode,
          ttfbMs,
          totalMs: performance.now() - start,
          tokensReceived,
          leadCaptured,
        });
      },
    });

    void handleRequest(reqEmitter, resEmitter);

    // Emit body chunks asynchronously on next tick
    queueMicrotask(() => {
      reqEmitter.emit("data", payload);
      reqEmitter.emit("end");
    });
  });
}

function percentile(sorted: number[], p: number): string {
  if (sorted.length === 0) return "0.0";
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx].toFixed(1);
}

async function runLoadTest() {
  await ragEngine.initialize();
  console.log(`🚀 Launching ${CONCURRENT_USERS} Simultaneous Users against TEC RAG Sales Engine...`);
  const suiteStart = performance.now();

  const promises = Array.from({ length: CONCURRENT_USERS }, (_, i) =>
    simulateSingleUserInMemory(i + 1)
  );

  const results = await Promise.all(promises);
  const suiteTotalMs = performance.now() - suiteStart;

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const leadsCaptured = results.filter((r) => r.leadCaptured).length;
  const ttfbs = succeeded.map((r) => r.ttfbMs).sort((a, b) => a - b);
  const totals = succeeded.map((r) => r.totalMs).sort((a, b) => a - b);
  const metrics = concurrencyGuard.getMetrics();
  const dbStats = getLeadStats();

  console.log("\n==================================================================");
  console.log(`📊 500-CONCURRENT-USER BENCHMARK RESULTS`);
  console.log("==================================================================");
  console.log(`• Concurrent Users Launched : ${CONCURRENT_USERS}`);
  console.log(`• Peak Simultaneous Streams : ${metrics.peakConcurrentStreams}`);
  console.log(`• Successful Streams        : ${succeeded.length} / ${CONCURRENT_USERS} (${((succeeded.length / CONCURRENT_USERS) * 100).toFixed(1)}%)`);
  console.log(`• Failed Requests           : ${failed.length}`);
  console.log(`• Leads Captured in Chat    : ${leadsCaptured} (Total in SQLite WAL DB: ${dbStats.total})`);
  console.log(`• Total Wall-Clock Time     : ${(suiteTotalMs / 1000).toFixed(2)}s`);
  console.log(`• Time-to-First-Token (P50) : ${percentile(ttfbs, 50)} ms`);
  console.log(`• Time-to-First-Token (P95) : ${percentile(ttfbs, 95)} ms`);
  console.log(`• Time-to-First-Token (P99) : ${percentile(ttfbs, 99)} ms`);
  console.log(`• Full Stream Time (P50)    : ${percentile(totals, 50)} ms`);
  console.log(`• Full Stream Time (P95)    : ${percentile(totals, 95)} ms`);
  console.log("==================================================================");

  if (failed.length > 0) {
    console.error("Sample failure:", failed[0]);
    process.exit(1);
  }

  // Clean up benchmark test leads so production DB remains clean
  clearTestLeads();
  process.exit(0);
}

void runLoadTest();
