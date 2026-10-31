import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ENV } from "../config/env.ts";
import {
  fetchRecentLeadsFromSupabase,
  insertLeadToSupabase,
  updateLeadSyncInSupabase,
} from "./supabase.ts";

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

const BACKEND_ROOT = path.resolve(import.meta.dirname, "../..");
// On Vercel Serverless, /var/task is read-only; use /tmp for local fallback storage
const isServerlessReadOnly = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
);
const dataDir = isServerlessReadOnly
  ? path.join(os.tmpdir(), "tec-chatbot-data")
  : path.join(BACKEND_ROOT, "data");
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "tec-chatbot.sqlite");
const db = new DatabaseSync(dbPath);

// Configure SQLite for high-concurrency (500+ simultaneous users)
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

const insertLeadStmt = db.prepare(`
  INSERT INTO leads (
    id, session_id, name, phone, area_required, budget,
    additional_enquiry, source, client_ip, sheet_synced, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
`);

const markLeadSyncedStmt = db.prepare(`
  UPDATE leads
  SET sheet_synced = ?, sheet_error = ?
  WHERE id = ?
`);

const getRecentLeadsStmt = db.prepare(`
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

const getLeadCountStmt = db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN sheet_synced = 1 THEN 1 ELSE 0 END) AS synced
  FROM leads
`);

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

  // Persist to Cloud Supabase PostgreSQL (`tec_sales_leads` table)
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
  markLeadSyncedStmt.run(synced ? 1 : -1, errorMsg, id);
  if (ENV.SUPABASE_ENABLED) {
    void updateLeadSyncInSupabase(id, synced, errorMsg);
  }
}

export function getLeadStats(): {
  total: number;
  synced: number;
  storageEngine: string;
} {
  const row = getLeadCountStmt.get() as { total?: number; synced?: number } | undefined;
  return {
    total: Number(row?.total || 0),
    synced: Number(row?.synced || 0),
    storageEngine: ENV.SUPABASE_ENABLED
      ? "Supabase Cloud PostgreSQL + pgvector"
      : "Local SQLite WAL (Add SUPABASE_URL in .env for Cloud DB)",
  };
}

export async function getRecentLeads(limit = 25): Promise<LeadRecord[]> {
  if (ENV.SUPABASE_ENABLED) {
    const cloudLeads = await fetchRecentLeadsFromSupabase(limit);
    if (cloudLeads) return cloudLeads;
  }
  return getRecentLeadsStmt.all(limit) as unknown as LeadRecord[];
}

export function clearTestLeads(): void {
  db.exec(`DELETE FROM leads WHERE session_id LIKE 'loadtest_session_%'`);
}
