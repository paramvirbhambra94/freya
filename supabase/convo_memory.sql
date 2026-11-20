-- Conversation memory: every turn persisted as it happens; sessions digested into summaries + facts.
create table if not exists public.convo_sessions (
  id text primary key,
  started_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  ended text,
  camera boolean not null default false,
  summary text,
  processed_upto bigint not null default 0,
  dirty boolean not null default true
);
create table if not exists public.convo_turns (
  id bigserial primary key,
  cid text unique,
  session_id text not null references public.convo_sessions(id) on delete cascade,
  role text not null check (role in ('user','freya','seen','note')),
  text text not null,
  mode text,
  created_at timestamptz not null default now()
);
create index if not exists convo_turns_created on public.convo_turns (created_at desc);
create index if not exists convo_turns_session on public.convo_turns (session_id, id);
create index if not exists convo_sessions_dirty on public.convo_sessions (dirty, last_at) where dirty;
alter table public.convo_sessions enable row level security;
alter table public.convo_turns enable row level security;
