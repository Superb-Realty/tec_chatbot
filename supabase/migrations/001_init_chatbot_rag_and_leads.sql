-- ============================================================================
-- THE EASTERN CHAMBERS — SUPABASE CLOUD DATABASE & PGVECTOR MIGRATION
-- Paste this entire file into your Supabase Dashboard -> SQL Editor -> Run
-- ============================================================================

-- 1. Enable pgvector extension for OpenAI text-embedding-3-small (1536 dims)
create extension if not exists vector;

-- ============================================================================
-- 2. RAG KNOWLEDGE BASE & FAQ VECTOR TABLE (`tec_knowledge_chunks`)
-- ============================================================================
create table if not exists public.tec_knowledge_chunks (
  id text primary key,
  source text not null,
  category text not null,
  title text not null,
  content text not null,
  tags text[] not null default '{}',
  content_hash text not null,
  embedding vector(1536),
  fts tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(category, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'C')
  ) stored,
  updated_at timestamptz not null default now()
);

-- HNSW Vector Index for sub-5ms Cosine Similarity search at scale
create index if not exists idx_tec_knowledge_embedding_hnsw
  on public.tec_knowledge_chunks
  using hnsw (embedding vector_cosine_ops);

-- GIN Full-Text Search Index for hybrid keyword + semantic retrieval
create index if not exists idx_tec_knowledge_fts_gin
  on public.tec_knowledge_chunks
  using gin (fts);

-- ============================================================================
-- 3. HYBRID RAG SEARCH RPC FUNCTION (pgvector Cosine + Full-Text Search RRF)
-- ============================================================================
create or replace function public.match_tec_knowledge_hybrid(
  query_embedding vector(1536),
  query_text text,
  match_count int default 4
)
returns table (
  id text,
  source text,
  category text,
  title text,
  content text,
  similarity float,
  fts_rank float,
  hybrid_score float
)
language sql stable
as $$
  with scored as (
    select
      k.id,
      k.source,
      k.category,
      k.title,
      k.content,
      case
        when k.embedding is not null and query_embedding is not null
        then 1 - (k.embedding <=> query_embedding)
        else 0.0
      end as sim_score,
      case
        when trim(query_text) <> ''
        then ts_rank_cd(k.fts, websearch_to_tsquery('english', query_text))
        else 0.0
      end as lex_score
    from public.tec_knowledge_chunks k
  )
  select
    id,
    source,
    category,
    title,
    content,
    sim_score as similarity,
    lex_score as fts_rank,
    (sim_score * 0.75) + (least(lex_score, 1.0) * 0.25) as hybrid_score
  from scored
  order by ((sim_score * 0.75) + (least(lex_score, 1.0) * 0.25)) desc
  limit match_count;
$$;

-- ============================================================================
-- 4. CAPTURED SALES LEADS TABLE (`tec_sales_leads`)
-- ============================================================================
create table if not exists public.tec_sales_leads (
  id text primary key,
  session_id text not null,
  name text not null,
  phone text not null,
  area_required text not null default '',
  budget text not null default '',
  additional_enquiry text not null default '',
  source text not null default 'chat_tool',
  client_ip text not null default '',
  sheet_synced boolean not null default false,
  sheet_error text default null,
  created_at timestamptz not null default now()
);

create index if not exists idx_tec_leads_created_at
  on public.tec_sales_leads (created_at desc);

create index if not exists idx_tec_leads_phone
  on public.tec_sales_leads (phone);

create index if not exists idx_tec_leads_unsynced
  on public.tec_sales_leads (sheet_synced)
  where sheet_synced = false;

-- ============================================================================
-- 5. DISTRIBUTED MULTI-INSTANCE RATE LIMITER (`tec_rate_limits`)
-- Shared across all Horizontally Scaled Backend Instances!
-- ============================================================================
create table if not exists public.tec_rate_limits (
  rate_key text primary key,
  request_count int not null default 1,
  reset_at timestamptz not null
);

create or replace function public.check_tec_rate_limit(
  p_key text,
  p_window_seconds int default 60,
  p_max_requests int default 35
)
returns table (
  allowed boolean,
  current_count int,
  retry_after_seconds int
)
language plpgsql
as $$
declare
  v_now timestamptz := now();
  v_reset timestamptz := v_now + make_interval(secs => p_window_seconds);
  v_count int;
  v_actual_reset timestamptz;
begin
  insert into public.tec_rate_limits (rate_key, request_count, reset_at)
  values (p_key, 1, v_reset)
  on conflict (rate_key) do update
  set
    request_count = case
      when public.tec_rate_limits.reset_at <= v_now then 1
      else public.tec_rate_limits.request_count + 1
    end,
    reset_at = case
      when public.tec_rate_limits.reset_at <= v_now then v_reset
      else public.tec_rate_limits.reset_at
    end
  returning request_count, reset_at into v_count, v_actual_reset;

  return query select
    (v_count <= p_max_requests) as allowed,
    v_count as current_count,
    greatest(0, ceil(extract(epoch from (v_actual_reset - v_now)))::int) as retry_after_seconds;
end;
$$;

-- ============================================================================
-- 6. ROW LEVEL SECURITY (RLS) — LOCK TABLES TO BACKEND SERVICE ROLE ONLY
-- ============================================================================
alter table public.tec_knowledge_chunks enable row level security;
alter table public.tec_sales_leads enable row level security;
alter table public.tec_rate_limits enable row level security;

