import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENV } from "../config/env.ts";
import {
  fetchRecentLeadsFromSupabase,
  insertLeadToSupabase,
  updateLeadSyncInSupabase,
  saveChatMessageToSupabase,
  fetchChatConversationsFromSupabase,
  type ChatMessageRecord,
} from "./supabase.ts";

export type { ChatMessageRecord };

export interface LeadRecord {
  id: string;
  sessionId: string;
  name: string;
  phone: string;
  areaRequired: string;
  budget: string;
  additionalEnquiry: string;
  source: "chat_tool" | "chat_form" | "chat_regex";
  clientIp: string;
  sheetSynced: number;
  createdAt: string;
}

// In-memory fallback ring buffer (holds up to 500 latest leads safely in RAM)
const memoryLeads: LeadRecord[] = [];

// SQLite instance & prepared statements (loaded dynamically if supported in runtime)
let dbInstance: any = null;
let insertLeadStmt: any = null;
let markLeadSyncedStmt: any = null;
let getRecentLeadsStmt: any = null;
let getLeadCountStmt: any = null;

const BACKEND_ROOT = path.resolve(import.meta.dirname, "../..");
const isServerless = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
);

// Initialize SQLite safely with graceful fallback for serverless or older Node versions
try {
  const sqliteModule = await import("node:sqlite");
  if (sqliteModule && typeof sqliteModule.DatabaseSync === "function") {
    const dataDir = isServerless
      ? path.join(os.tmpdir(), "tec-chatbot-data")
      : path.join(BACKEND_ROOT, "data");

    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const dbPath = path.join(dataDir, "tec-chatbot.sqlite");
      const db = new sqliteModule.DatabaseSync(dbPath);

      // Configure SQLite for high concurrency
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA temp_store = MEMORY;
        PRAGMA cache_size = -20000;

        CREATE TABLE IF NOT EXISTS leads (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          name TEXT NOT NULL,
          phone TEXT NOT NULL,
          area_required TEXT DEFAULT '',
          budget TEXT DEFAULT '',
          additional_enquiry TEXT DEFAULT '',
          source TEXT DEFAULT 'chat_tool',
          client_ip TEXT DEFAULT '',
          sheet_synced INTEGER DEFAULT 0,
          sheet_error TEXT DEFAULT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
        CREATE INDEX IF NOT EXISTS idx_leads_synced ON leads(sheet_synced);
        CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);
      `);

      insertLeadStmt = db.prepare(`
        INSERT INTO leads (
          id, session_id, name, phone, area_required, budget,
          additional_enquiry, source, client_ip, sheet_synced, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `);

      markLeadSyncedStmt = db.prepare(`
        UPDATE leads
        SET sheet_synced = ?, sheet_error = ?
        WHERE id = ?
      `);

      getRecentLeadsStmt = db.prepare(`
        SELECT
          id,
          session_id AS sessionId,
          name,
          phone,
          area_required AS areaRequired,
          budget,
          additional_enquiry AS additionalEnquiry,
          source,
          client_ip AS clientIp,
          sheet_synced AS sheetSynced,
          created_at AS createdAt
        FROM leads
        ORDER BY created_at DESC
        LIMIT ?
      `);

      getLeadCountStmt = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN sheet_synced = 1 THEN 1 ELSE 0 END) AS synced
        FROM leads
      `);

      dbInstance = db;
    } catch (fsErr) {
      console.warn("[DB] SQLite database directory initialization skipped:", fsErr);
    }
  }
} catch {
  // node:sqlite is not available or disabled in this runtime
  console.log("[DB] SQLite native engine not present in runtime. Falling back to Supabase + In-Memory store.");
}

/**
 * Neutralize spreadsheet formula injection (=, +, -, @)
 */
export function sanitizeSpreadsheetCell(val: unknown, maxLength: number): string {
  if (val === null || val === undefined) return "";
  let str = String(val).trim().slice(0, maxLength);
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  return str;
}

export function saveLeadToDb(input: {
  sessionId: string;
  name: string;
  phone: string;
  areaRequired?: string;
  budget?: string;
  additionalEnquiry?: string;
  source?: "chat_tool" | "chat_form" | "chat_regex";
  clientIp?: string;
}): LeadRecord {
  const id = `lead_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();

  const record: LeadRecord = {
    id,
    sessionId: sanitizeSpreadsheetCell(input.sessionId || "anon", 80),
    name: sanitizeSpreadsheetCell(input.name, 120),
    phone: sanitizeSpreadsheetCell(input.phone, 35),
    areaRequired: sanitizeSpreadsheetCell(input.areaRequired || "", 120),
    budget: sanitizeSpreadsheetCell(input.budget || "", 120),
    additionalEnquiry: sanitizeSpreadsheetCell(input.additionalEnquiry || "", 1000),
    source: input.source || "chat_tool",
    clientIp: (input.clientIp || "127.0.0.1").replace(/\.\d+$/, ".xxx"),
    sheetSynced: 0,
    createdAt,
  };

  // 1. Try local SQLite insert if available
  if (insertLeadStmt) {
    try {
      insertLeadStmt.run(
        record.id,
        record.sessionId,
        record.name,
        record.phone,
        record.areaRequired,
        record.budget,
        record.additionalEnquiry,
        record.source,
        record.clientIp,
        record.createdAt
      );
    } catch (err) {
      console.warn("[DB] SQLite insert failed:", err);
    }
  }

  // 2. Keep in memory buffer
  memoryLeads.unshift(record);
  if (memoryLeads.length > 500) {
    memoryLeads.pop();
  }

  // 3. Persist to Cloud Supabase PostgreSQL (`tec_sales_leads` table)
  if (ENV.SUPABASE_ENABLED) {
    void insertLeadToSupabase(record);
  }

  return record;
}

export function updateLeadSyncStatus(
  id: string,
  synced: boolean,
  errorMsg: string | null = null
): void {
  if (markLeadSyncedStmt) {
    try {
      markLeadSyncedStmt.run(synced ? 1 : -1, errorMsg, id);
    } catch {}
  }

  const inMem = memoryLeads.find((l) => l.id === id);
  if (inMem) {
    inMem.sheetSynced = synced ? 1 : -1;
  }

  if (ENV.SUPABASE_ENABLED) {
    void updateLeadSyncInSupabase(id, synced, errorMsg);
  }
}

export function getLeadStats(): {
  total: number;
  synced: number;
  storageEngine: string;
} {
  if (getLeadCountStmt) {
    try {
      const row = getLeadCountStmt.get() as { total?: number; synced?: number } | undefined;
      return {
        total: Number(row?.total || memoryLeads.length),
        synced: Number(row?.synced || memoryLeads.filter((l) => l.sheetSynced === 1).length),
        storageEngine: ENV.SUPABASE_ENABLED
          ? "Supabase Cloud PostgreSQL + pgvector"
          : "Local SQLite WAL",
      };
    } catch {}
  }

  return {
    total: memoryLeads.length,
    synced: memoryLeads.filter((l) => l.sheetSynced === 1).length,
    storageEngine: ENV.SUPABASE_ENABLED
      ? "Supabase Cloud PostgreSQL + pgvector"
      : "In-Memory Buffer (Add SUPABASE_URL in .env for Cloud DB)",
  };
}

export async function getRecentLeads(limit = 25): Promise<LeadRecord[]> {
  if (ENV.SUPABASE_ENABLED) {
    const cloudLeads = await fetchRecentLeadsFromSupabase(limit);
    if (cloudLeads) return cloudLeads;
  }

  if (getRecentLeadsStmt) {
    try {
      return getRecentLeadsStmt.all(limit) as unknown as LeadRecord[];
    } catch {}
  }

  return memoryLeads.slice(0, limit);
}

export function clearTestLeads(): void {
  if (dbInstance) {
    try {
      dbInstance.exec(`DELETE FROM leads WHERE session_id LIKE 'loadtest_session_%'`);
    } catch {}
  }
  for (let i = memoryLeads.length - 1; i >= 0; i--) {
    if (memoryLeads[i].sessionId.startsWith("loadtest_session_")) {
      memoryLeads.splice(i, 1);
    }
  }
}

// In-memory conversation buffer (holds up to 1,500 recent turns for fast analytics)
const memoryConversations: ChatMessageRecord[] = [];

/**
 * Persists an incoming user or assistant message for session review & analytics.
 * Synchronously buffers in memory and asynchronously saves to Supabase `tec_chat_conversations`.
 */
export function saveChatMessage(input: {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  sources?: Array<{ id: string; title: string; category: string; score: number }>;
  leadCaptured?: { id: string; name: string; phone: string } | null;
  clientIp?: string;
}): ChatMessageRecord {
  const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const createdAt = new Date().toISOString();

  const record: ChatMessageRecord = {
    id,
    sessionId: input.sessionId,
    role: input.role,
    content: input.content,
    sources: input.sources,
    leadCaptured: input.leadCaptured,
    clientIp: (input.clientIp || "127.0.0.1").replace(/\.\d+$/, ".xxx"),
    createdAt,
  };

  memoryConversations.unshift(record);
  if (memoryConversations.length > 1500) {
    memoryConversations.pop();
  }

  // Persist to Cloud Supabase PostgreSQL (`tec_chat_conversations` table)
  if (ENV.SUPABASE_ENABLED) {
    void saveChatMessageToSupabase(record);
  }

  return record;
}

/**
 * Retrieves conversation logs for analytics and performance review.
 */
export async function getRecentConversations(params?: {
  sessionId?: string;
  limit?: number;
}): Promise<ChatMessageRecord[]> {
  const limit = params?.limit || 50;

  if (ENV.SUPABASE_ENABLED) {
    const cloudMsgs = await fetchChatConversationsFromSupabase({
      sessionId: params?.sessionId,
      limit,
    });
    if (cloudMsgs) return cloudMsgs;
  }

  if (params?.sessionId) {
    return memoryConversations
      .filter((m) => m.sessionId === params.sessionId)
      .slice(0, limit);
  }

  return memoryConversations.slice(0, limit);
}
