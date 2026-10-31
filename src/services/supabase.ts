import { ENV } from "../config/env.ts";
import type { LeadRecord } from "./db.ts";
import type { KnowledgeChunk, RetrievedChunk } from "../rag/engine.ts";

function getSupabaseHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey: ENV.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

/**
 * 1. Syncs indexed Knowledge & FAQ chunks + 1536-dim OpenAI embeddings to Supabase `tec_knowledge_chunks`
 */
export async function syncKnowledgeChunksToSupabase(
  chunks: KnowledgeChunk[]
): Promise<boolean> {
  if (!ENV.SUPABASE_ENABLED || chunks.length === 0) return false;

  try {
    const rows = chunks.map((c) => ({
      id: c.id,
      source: c.source,
      category: c.category,
      title: c.title,
      content: c.content,
      tags: c.tags,
      content_hash: c.hash,
      embedding: c.embedding ? `[${c.embedding.join(",")}]` : null,
      updated_at: new Date().toISOString(),
    }));

    const res = await fetch(`${ENV.SUPABASE_URL}/rest/v1/tec_knowledge_chunks`, {
      method: "POST",
      headers: getSupabaseHeaders({
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify(rows),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn(
        `[Supabase] Knowledge upsert returned HTTP ${res.status}: ${errText.slice(0, 200)}`
      );
      return false;
    }

    return true;
  } catch (err) {
    console.warn(
      "[Supabase] Failed to sync knowledge chunks:",
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

/**
 * 2. Executes Hybrid Search (pgvector Cosine Similarity + PostgreSQL Full-Text Search)
 * directly inside Supabase via the `match_tec_knowledge_hybrid` RPC function.
 */
export async function searchKnowledgeInSupabase(params: {
  queryText: string;
  queryEmbedding: number[] | null;
  topK: number;
}): Promise<RetrievedChunk[] | null> {
  if (!ENV.SUPABASE_ENABLED) return null;

  try {
    const res = await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/rpc/match_tec_knowledge_hybrid`,
      {
        method: "POST",
        headers: getSupabaseHeaders(),
        body: JSON.stringify({
          query_embedding: params.queryEmbedding
            ? `[${params.queryEmbedding.join(",")}]`
            : null,
          query_text: params.queryText,
          match_count: params.topK,
        }),
      }
    );

    if (!res.ok) return null;

    const rows = (await res.json()) as Array<{
      id: string;
      source: string;
      category: string;
      title: string;
      content: string;
      similarity: number;
      fts_rank: number;
      hybrid_score: number;
    }>;

    if (!Array.isArray(rows) || rows.length === 0) return null;

    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      category: r.category,
      title: r.title,
      content: r.content,
      score: Number((r.hybrid_score || 0).toFixed(4)),
      matchType: "hybrid" as const,
    }));
  } catch {
    return null;
  }
}

/**
 * 3. Inserts a captured sales lead into Supabase `tec_sales_leads`
 */
export async function insertLeadToSupabase(lead: LeadRecord): Promise<boolean> {
  if (!ENV.SUPABASE_ENABLED) return false;

  try {
    const res = await fetch(`${ENV.SUPABASE_URL}/rest/v1/tec_sales_leads`, {
      method: "POST",
      headers: getSupabaseHeaders({
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify({
        id: lead.id,
        session_id: lead.sessionId,
        name: lead.name,
        phone: lead.phone,
        area_required: lead.areaRequired,
        budget: lead.budget,
        additional_enquiry: lead.additionalEnquiry,
        source: lead.source,
        client_ip: lead.clientIp,
        sheet_synced: Boolean(lead.sheetSynced),
        created_at: lead.createdAt,
      }),
    });

    return res.ok;
  } catch (err) {
    console.warn(
      "[Supabase] Lead insert warning:",
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

/**
 * 4. Updates Google Sheet sync status for a lead in Supabase `tec_sales_leads`
 */
export async function updateLeadSyncInSupabase(
  id: string,
  synced: boolean,
  errorMsg: string | null
): Promise<void> {
  if (!ENV.SUPABASE_ENABLED) return;

  try {
    await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/tec_sales_leads?id=eq.${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: getSupabaseHeaders({ Prefer: "return=minimal" }),
        body: JSON.stringify({
          sheet_synced: synced,
          sheet_error: errorMsg,
        }),
      }
    );
  } catch {
    // Non-fatal background update
  }
}

/**
 * 5. Fetches recent leads from Supabase `tec_sales_leads`
 */
export async function fetchRecentLeadsFromSupabase(
  limit = 25
): Promise<LeadRecord[] | null> {
  if (!ENV.SUPABASE_ENABLED) return null;

  try {
    const res = await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/tec_sales_leads?select=*&order=created_at.desc&limit=${limit}`,
      {
        method: "GET",
        headers: getSupabaseHeaders(),
      }
    );

    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{
      id: string;
      session_id: string;
      name: string;
      phone: string;
      area_required: string;
      budget: string;
      additional_enquiry: string;
      source: "chat_tool" | "chat_form" | "chat_regex" | "chat_direct";
      client_ip: string;
      sheet_synced: boolean;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      name: r.name,
      phone: r.phone,
      areaRequired: r.area_required,
      budget: r.budget,
      additionalEnquiry: r.additional_enquiry,
      source: r.source,
      clientIp: r.client_ip,
      sheetSynced: r.sheet_synced ? 1 : 0,
      createdAt: r.created_at,
    }));
  } catch {
    return null;
  }
}

/**
 * 6. Distributed Rate Limiter across multiple backend instances via Supabase RPC
 */
export async function checkDistributedRateLimitInSupabase(params: {
  key: string;
  windowSeconds: number;
  maxRequests: number;
}): Promise<{ allowed: boolean; retryAfterSeconds?: number } | null> {
  if (!ENV.SUPABASE_ENABLED) return null;

  try {
    const res = await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/rpc/check_tec_rate_limit`,
      {
        method: "POST",
        headers: getSupabaseHeaders(),
        body: JSON.stringify({
          p_key: params.key,
          p_window_seconds: params.windowSeconds,
          p_max_requests: params.maxRequests,
        }),
      }
    );

    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{
      allowed: boolean;
      current_count: number;
      retry_after_seconds: number;
    }>;

    if (!rows || !rows[0]) return null;
    return {
      allowed: Boolean(rows[0].allowed),
      retryAfterSeconds: rows[0].retry_after_seconds,
    };
  } catch {
    return null;
  }
}

export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  sources?: Array<{ id: string; title: string; category: string; score: number }>;
  leadCaptured?: { id: string; name: string; phone: string } | null;
  clientIp?: string;
  createdAt: string;
}

/**
 * 7. Asynchronously logs conversation turns to Supabase `tec_chat_conversations`
 */
export async function saveChatMessageToSupabase(
  msg: ChatMessageRecord
): Promise<boolean> {
  if (!ENV.SUPABASE_ENABLED) return false;

  try {
    const res = await fetch(`${ENV.SUPABASE_URL}/rest/v1/tec_chat_conversations`, {
      method: "POST",
      headers: getSupabaseHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify({
        id: msg.id,
        session_id: msg.sessionId,
        role: msg.role,
        content: msg.content,
        sources: msg.sources || [],
        lead_captured: msg.leadCaptured || null,
        client_ip: msg.clientIp || "",
        created_at: msg.createdAt,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 8. Fetches conversation history for analysis (Protected admin endpoint)
 */
export async function fetchChatConversationsFromSupabase(params?: {
  sessionId?: string;
  limit?: number;
}): Promise<ChatMessageRecord[] | null> {
  if (!ENV.SUPABASE_ENABLED) return null;

  try {
    const limit = params?.limit || 100;
    const sessionFilter = params?.sessionId
      ? `&session_id=eq.${encodeURIComponent(params.sessionId)}`
      : "";
    const res = await fetch(
      `${ENV.SUPABASE_URL}/rest/v1/tec_chat_conversations?select=*${sessionFilter}&order=created_at.desc&limit=${limit}`,
      {
        method: "GET",
        headers: getSupabaseHeaders(),
      }
    );

    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{
      id: string;
      session_id: string;
      role: "user" | "assistant";
      content: string;
      sources: Array<{ id: string; title: string; category: string; score: number }>;
      lead_captured: { id: string; name: string; phone: string } | null;
      client_ip: string;
      created_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      content: r.content,
      sources: r.sources,
      leadCaptured: r.lead_captured,
      clientIp: r.client_ip,
      createdAt: r.created_at,
    }));
  } catch {
    return null;
  }
}

