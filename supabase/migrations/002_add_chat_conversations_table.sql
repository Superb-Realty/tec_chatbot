-- ============================================================================
-- THE EASTERN CHAMBERS — CONVERSATION LOGGING & ANALYTICS (`tec_chat_conversations`)
-- Paste into Supabase Dashboard -> SQL Editor -> Run
-- ============================================================================

create table if not exists public.tec_chat_conversations (
  id text primary key,
  session_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  sources jsonb default '[]'::jsonb,
  lead_captured jsonb default null,
  client_ip text default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_tec_convos_session
  on public.tec_chat_conversations (session_id, created_at asc);

create index if not exists idx_tec_convos_created
  on public.tec_chat_conversations (created_at desc);

-- Row Level Security: Write-only for service role (Chatbot AI cannot read past sessions)
alter table public.tec_chat_conversations enable row level security;
