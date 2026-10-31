import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENV } from "../config/env.ts";
import {
  searchKnowledgeInSupabase,
  syncKnowledgeChunksToSupabase,
} from "../services/supabase.ts";

export interface FaqEntry {
  id: string;
  category: string;
  question: string;
  answer: string;
  tags?: string[];
}

export interface KnowledgeChunk {
  id: string;
  source: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  hash: string;
  embedding?: number[];
  tokens: string[];
  tokenFreq: Map<string, number>;
}

export interface RetrievedChunk {
  id: string;
  source: string;
  category: string;
  title: string;
  content: string;
  score: number;
  matchType: "hybrid" | "vector" | "bm25";
}

interface PersistedVectorIndex {
  model: string;
  updatedAt: string;
  vectors: Record<string, { hash: string; embedding: number[] }>;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "in", "on", "at", "to", "for", "of", "with", "by", "about", "as",
  "into", "like", "through", "after", "over", "between", "out", "against",
  "during", "without", "before", "under", "around", "among", "what", "which",
  "who", "whom", "this", "that", "these", "those", "am", "have", "has", "had",
  "do", "does", "did", "can", "could", "will", "would", "should", "may",
  "might", "must", "how", "where", "when", "why", "and", "or", "but", "if",
  "me", "my", "we", "our", "you", "your", "it", "its", "they", "them", "their",
  "tell", "please", "know", "want", "need", "eastern", "chambers", "chamber", "tec"
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+.\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

class HybridRagEngine {
  private chunks: KnowledgeChunk[] = [];
  private idfMap = new Map<string, number>();
  private avgDocLen = 1;
  private queryEmbeddingCache = new Map<string, number[]>();
  private readonly maxQueryCacheSize = 2000;
  private knowledgeDir = path.resolve(import.meta.dirname, "../../knowledge");
  private vectorCachePath =
    process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
      ? path.join(os.tmpdir(), "tec-chatbot-data/vector-index.json")
      : path.resolve(import.meta.dirname, "../../data/vector-index.json");
  private isIndexing = false;
  private isInitialized = false;
  private lastIndexedAt = "";

  public async initialize(): Promise<void> {
    if (this.isInitialized && this.chunks.length > 0) return;
    await this.reloadIndex();
    if (!process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
      this.setupHotWatcher();
    }
    this.isInitialized = true;
  }

  private setupHotWatcher(): void {
    if (!fs.existsSync(this.knowledgeDir)) return;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    try {
      fs.watch(this.knowledgeDir, (_eventType, filename) => {
        if (!filename || filename === "README.md") return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          console.log(`[RAG] Detected change in knowledge/${filename} — hot-reloading index...`);
          void this.reloadIndex();
        }, 600);
      });
    } catch {
      // fs.watch may not be supported on some virtual filesystems
    }
  }

  public async reloadIndex(): Promise<{
    chunkCount: number;
    faqCount: number;
    vectorsReady: number;
  }> {
    if (this.isIndexing) {
      return this.getStatus();
    }
    this.isIndexing = true;

    try {
      const loadedChunks: KnowledgeChunk[] = [];

      // 1. Load FAQs from knowledge/faqs.json
      const faqsPath = path.join(this.knowledgeDir, "faqs.json");
      if (fs.existsSync(faqsPath)) {
        try {
          const rawFaqs = JSON.parse(fs.readFileSync(faqsPath, "utf-8")) as FaqEntry[];
          for (const faq of rawFaqs) {
            if (!faq.question || !faq.answer) continue;
            const fullText = `FAQ Question: ${faq.question}\nAnswer: ${faq.answer}`;
            const hash = crypto.createHash("sha256").update(fullText).digest("hex").slice(0, 16);
            const tokens = tokenize(`${faq.question} ${faq.answer} ${(faq.tags || []).join(" ")} ${faq.category || ""}`);
            const tokenFreq = new Map<string, number>();
            for (const tok of tokens) {
              tokenFreq.set(tok, (tokenFreq.get(tok) || 0) + 1);
            }

            loadedChunks.push({
              id: faq.id || `faq-${hash.slice(0, 8)}`,
              source: "faqs.json",
              category: faq.category || "FAQ",
              title: faq.question,
              content: fullText,
              tags: (faq.tags || []).map((t) => t.toLowerCase()),
              hash,
              tokens,
              tokenFreq,
            });
          }
        } catch (err) {
          console.error("[RAG] Failed to parse knowledge/faqs.json:", err);
        }
      }

      // 2. Load Markdown & Text documents from knowledge/*.md
      if (fs.existsSync(this.knowledgeDir)) {
        const files = fs.readdirSync(this.knowledgeDir);
        for (const file of files) {
          if (file === "README.md" || file === "faqs.json") continue;
          if (!file.endsWith(".md") && !file.endsWith(".txt")) continue;

          const fullPath = path.join(this.knowledgeDir, file);
          const rawText = fs.readFileSync(fullPath, "utf-8");

          // Split by ## H2 sections for semantic granularity
          const sections = rawText.split(/\n(?=##\s+)/g);
          for (let i = 0; i < sections.length; i++) {
            const sec = sections[i].trim();
            if (sec.length < 30) continue;

            const firstLineEnd = sec.indexOf("\n");
            const rawHeading =
              firstLineEnd !== -1 ? sec.slice(0, firstLineEnd) : file;
            const cleanTitle = rawHeading.replace(/^#+\s*/, "").trim();

            const hash = crypto
              .createHash("sha256")
              .update(sec)
              .digest("hex")
              .slice(0, 16);
            const tokens = tokenize(`${cleanTitle} ${sec}`);
            const tokenFreq = new Map<string, number>();
            for (const tok of tokens) {
              tokenFreq.set(tok, (tokenFreq.get(tok) || 0) + 1);
            }

            loadedChunks.push({
              id: `${file.replace(/\.[^.]+$/, "")}-sec-${i + 1}`,
              source: file,
              category: cleanTitle,
              title: cleanTitle,
              content: sec,
              tags: tokenize(cleanTitle),
              hash,
              tokens,
              tokenFreq,
            });
          }
        }
      }

      // 3. Compute BM25 IDF statistics
      this.computeBm25Stats(loadedChunks);

      // 4. Load & sync OpenAI Vector Embeddings (if cached or API key configured)
      await this.syncVectorEmbeddings(loadedChunks);

      // 5. Sync Knowledge Chunks & Embeddings to Cloud Supabase pgvector (when configured)
      if (ENV.SUPABASE_ENABLED) {
        const synced = await syncKnowledgeChunksToSupabase(loadedChunks);
        if (synced) {
          console.log(
            `[RAG] Synced ${loadedChunks.length} knowledge chunks to Supabase pgvector.`
          );
        }
      }

      this.chunks = loadedChunks;
      this.lastIndexedAt = new Date().toISOString();

      return this.getStatus();
    } finally {
      this.isIndexing = false;
    }
  }

  private computeBm25Stats(chunks: KnowledgeChunk[]): void {
    const N = Math.max(1, chunks.length);
    let totalLen = 0;
    const docFreq = new Map<string, number>();

    for (const chunk of chunks) {
      totalLen += chunk.tokens.length;
      const uniqueTokens = new Set(chunk.tokens);
      for (const tok of uniqueTokens) {
        docFreq.set(tok, (docFreq.get(tok) || 0) + 1);
      }
    }

    this.avgDocLen = Math.max(1, totalLen / N);
    this.idfMap.clear();

    for (const [tok, df] of docFreq.entries()) {
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      this.idfMap.set(tok, idf);
    }
  }

  private async syncVectorEmbeddings(chunks: KnowledgeChunk[]): Promise<void> {
    let persisted: PersistedVectorIndex = {
      model: ENV.OPENAI_EMBEDDING_MODEL,
      updatedAt: new Date().toISOString(),
      vectors: {},
    };

    if (fs.existsSync(this.vectorCachePath)) {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(this.vectorCachePath, "utf-8")
        ) as PersistedVectorIndex;
        if (parsed.model === ENV.OPENAI_EMBEDDING_MODEL && parsed.vectors) {
          persisted = parsed;
        }
      } catch {
        // Ignore corrupt cache file
      }
    }

    const missingChunks: KnowledgeChunk[] = [];
    for (const chunk of chunks) {
      const cached = persisted.vectors[chunk.id];
      if (cached && cached.hash === chunk.hash && Array.isArray(cached.embedding)) {
        chunk.embedding = cached.embedding;
      } else {
        missingChunks.push(chunk);
      }
    }

    if (missingChunks.length > 0 && ENV.OPENAI_API_KEY) {
      try {
        const inputs = missingChunks.map(
          (c) => `${c.category}: ${c.title}\n${c.content}`
        );
        const embeddings = await this.fetchOpenAiEmbeddings(inputs);
        if (embeddings && embeddings.length === missingChunks.length) {
          for (let i = 0; i < missingChunks.length; i++) {
            const ch = missingChunks[i];
            ch.embedding = embeddings[i];
            persisted.vectors[ch.id] = {
              hash: ch.hash,
              embedding: embeddings[i],
            };
          }
          persisted.updatedAt = new Date().toISOString();
          fs.mkdirSync(path.dirname(this.vectorCachePath), { recursive: true });
          fs.writeFileSync(
            this.vectorCachePath,
            JSON.stringify(persisted),
            "utf-8"
          );
          console.log(
            `[RAG] Computed & cached ${missingChunks.length} OpenAI embeddings (${ENV.OPENAI_EMBEDDING_MODEL}).`
          );
        }
      } catch (err) {
        console.warn(
          "[RAG] OpenAI embedding sync skipped (falling back to BM25 + cached vectors):",
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  private async fetchOpenAiEmbeddings(texts: string[]): Promise<number[][] | null> {
    if (!ENV.OPENAI_API_KEY || texts.length === 0) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ENV.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: ENV.OPENAI_EMBEDDING_MODEL,
          input: texts,
        }),
        signal: controller.signal,
      });

      if (!res.ok) return null;
      const data = (await res.json()) as {
        data?: Array<{ embedding: number[]; index: number }>;
      };
      if (!data.data) return null;
      return data.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async getQueryEmbedding(query: string): Promise<number[] | null> {
    if (!ENV.OPENAI_API_KEY) return null;
    const normalizedKey = query.toLowerCase().trim();
    const cached = this.queryEmbeddingCache.get(normalizedKey);
    if (cached) {
      // Refresh LRU order
      this.queryEmbeddingCache.delete(normalizedKey);
      this.queryEmbeddingCache.set(normalizedKey, cached);
      return cached;
    }

    const res = await this.fetchOpenAiEmbeddings([normalizedKey]);
    if (!res || !res[0]) return null;

    if (this.queryEmbeddingCache.size >= this.maxQueryCacheSize) {
      const oldestKey = this.queryEmbeddingCache.keys().next().value;
      if (oldestKey) this.queryEmbeddingCache.delete(oldestKey);
    }
    this.queryEmbeddingCache.set(normalizedKey, res[0]);
    return res[0];
  }

  /**
   * Hybrid Search: Combines OpenAI Vector Cosine Similarity + BM25 + Tag Boost
   * using Reciprocal Rank Fusion (RRF) for sub-millisecond in-memory ranking.
   */
  public async retrieve(query: string, topK = 4): Promise<RetrievedChunk[]> {
    if (this.chunks.length === 0) return [];

    const queryTokens = tokenize(query);
    const queryLower = query.toLowerCase();

    // 1. Compute BM25 + Tag/Title Boost scores
    const k1 = 1.5;
    const b = 0.75;
    const bm25Scores = new Map<string, number>();

    for (const chunk of this.chunks) {
      let score = 0;
      const docLen = chunk.tokens.length;

      for (const qTok of queryTokens) {
        const tf = chunk.tokenFreq.get(qTok) || 0;
        if (tf > 0) {
          const idf = this.idfMap.get(qTok) || 0.5;
          const num = tf * (k1 + 1);
          const denom = tf + k1 * (1 - b + b * (docLen / this.avgDocLen));
          score += idf * (num / denom);
        }

        // Prefix / substring boost for partial matches (e.g. "rera", "metro", "leed")
        for (const tag of chunk.tags) {
          if (tag === qTok || (qTok.length >= 3 && tag.includes(qTok))) {
            score += 2.2;
          }
        }
        if (chunk.title.toLowerCase().includes(qTok)) {
          score += 1.6;
        }
      }

      // Exact phrase match bonus
      if (queryTokens.length >= 2 && chunk.content.toLowerCase().includes(queryLower)) {
        score += 3.0;
      }

      bm25Scores.set(chunk.id, score);
    }

    // 2. Check if we have vector embeddings available
    const hasChunkEmbeddings = this.chunks.some((c) => Array.isArray(c.embedding));
    let queryEmbedding: number[] | null = null;
    if ((hasChunkEmbeddings || ENV.SUPABASE_ENABLED) && ENV.OPENAI_API_KEY) {
      queryEmbedding = await this.getQueryEmbedding(query);
    }

    // 2b. If Cloud Supabase pgvector is enabled, query `match_tec_knowledge_hybrid` RPC
    if (ENV.SUPABASE_ENABLED) {
      const cloudResults = await searchKnowledgeInSupabase({
        queryText: query,
        queryEmbedding,
        topK,
      });
      if (cloudResults && cloudResults.length > 0) {
        return cloudResults;
      }
    }

    // 3. Fuse Vector + BM25 via Reciprocal Rank Fusion (RRF)
    if (queryEmbedding) {
      const vectorRank = [...this.chunks]
        .map((c) => ({
          chunk: c,
          sim: c.embedding ? cosineSimilarity(queryEmbedding!, c.embedding) : 0,
        }))
        .sort((a, b) => b.sim - a.sim);

      const bm25Rank = [...this.chunks]
        .map((c) => ({
          chunk: c,
          bm25: bm25Scores.get(c.id) || 0,
        }))
        .sort((a, b) => b.bm25 - a.bm25);

      const rrfScores = new Map<string, number>();
      const kRrf = 40;

      vectorRank.forEach((item, idx) => {
        const prev = rrfScores.get(item.chunk.id) || 0;
        rrfScores.set(item.chunk.id, prev + 1.15 / (kRrf + idx + 1) + item.sim * 0.25);
      });

      bm25Rank.forEach((item, idx) => {
        if (item.bm25 <= 0) return;
        const prev = rrfScores.get(item.chunk.id) || 0;
        rrfScores.set(item.chunk.id, prev + 1.0 / (kRrf + idx + 1));
      });

      return [...this.chunks]
        .map((c) => ({
          id: c.id,
          source: c.source,
          category: c.category,
          title: c.title,
          content: c.content,
          score: Number((rrfScores.get(c.id) || 0).toFixed(4)),
          matchType: "hybrid" as const,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    }

    // Fallback to pure BM25 + Tag-Boosted Lexical Ranking (< 1ms)
    const ranked = [...this.chunks]
      .map((c) => ({
        id: c.id,
        source: c.source,
        category: c.category,
        title: c.title,
        content: c.content,
        score: Number((bm25Scores.get(c.id) || 0).toFixed(4)),
        matchType: "bm25" as const,
      }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);

    if (ranked.length === 0) {
      // Return core overview chunks if query is purely conversational greeting
      return this.chunks.slice(0, Math.min(2, topK)).map((c) => ({
        id: c.id,
        source: c.source,
        category: c.category,
        title: c.title,
        content: c.content,
        score: 0.1,
        matchType: "bm25" as const,
      }));
    }

    return ranked.slice(0, topK);
  }

  /**
   * Programmatically append or update an FAQ in knowledge/faqs.json and hot-reload
   */
  public async upsertFaq(faq: FaqEntry): Promise<FaqEntry[]> {
    const faqsPath = path.join(this.knowledgeDir, "faqs.json");
    let existing: FaqEntry[] = [];
    if (fs.existsSync(faqsPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(faqsPath, "utf-8")) as FaqEntry[];
      } catch {
        existing = [];
      }
    }

    const idx = existing.findIndex((item) => item.id === faq.id);
    if (idx >= 0) {
      existing[idx] = faq;
    } else {
      existing.push(faq);
    }

    fs.writeFileSync(faqsPath, JSON.stringify(existing, null, 2), "utf-8");
    await this.reloadIndex();
    return existing;
  }

  public getFaqs(): FaqEntry[] {
    const faqsPath = path.join(this.knowledgeDir, "faqs.json");
    if (!fs.existsSync(faqsPath)) return [];
    try {
      return JSON.parse(fs.readFileSync(faqsPath, "utf-8")) as FaqEntry[];
    } catch {
      return [];
    }
  }

  public getStatus() {
    const faqCount = this.chunks.filter((c) => c.source === "faqs.json").length;
    const vectorsReady = this.chunks.filter((c) => Array.isArray(c.embedding)).length;
    return {
      chunkCount: this.chunks.length,
      faqCount,
      vectorsReady,
      embeddingModel: ENV.OPENAI_EMBEDDING_MODEL,
      openAiConfigured: Boolean(ENV.OPENAI_API_KEY),
      supabasePgVectorConnected: ENV.SUPABASE_ENABLED,
      queryCacheSize: this.queryEmbeddingCache.size,
      lastIndexedAt: this.lastIndexedAt,
    };
  }
}

export const ragEngine = new HybridRagEngine();
