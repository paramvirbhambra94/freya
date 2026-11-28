-- NEURO personal alpha: additive tables only (no changes to existing tables or data).
-- Rollback: drop table if exists neuro_priorities, neuro_actions, neuro_observations, neuro_futures, neuro_sleep;
create table if not exists neuro_priorities (
  id bigint generated always as identity primary key,
  day date not null,
  title text not null check (char_length(title) between 1 and 180),
  done boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists neuro_priorities_day on neuro_priorities (day);

-- Action ledger + approvals: every external/consequential action Freya proposes. Deny by default.
create table if not exists neuro_actions (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  params jsonb not null default '{}'::jsonb,
  params_hash text not null,
  why text,
  risk text not null default 'high',
  authority text not null default 'approval',
  status text not null default 'pending' check (status in ('pending','approved','denied','expired','executed','failed','cancelled')),
  result jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  decided_at timestamptz,
  executed_at timestamptz
);
create index if not exists neuro_actions_status on neuro_actions (status, created_at desc);

-- What Freya learned: derived observations only (never raw audio), with evidence + confidence, editable/deletable.
create table if not exists neuro_observations (
  id bigint generated always as identity primary key,
  domain text not null,
  text text not null,
  evidence text,
  confidence text not null default 'low' check (confidence in ('low','medium','high')),
  source text not null,
  status text not null default 'active' check (status in ('active','corrected','dismissed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists neuro_observations_created on neuro_observations (created_at desc);

-- Futures (outcome simulation) runs, kept so outcomes can be checked later.
create table if not exists neuro_futures (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  result jsonb not null,
  chosen text,
  outcome text,
  created_at timestamptz not null default now()
);

-- Sleep Focus: derived per-session summaries only (no audio).
create table if not exists neuro_sleep (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  ended_at timestamptz,
  summary jsonb not null default '{}'::jsonb,
  tiredness int,
  created_at timestamptz not null default now()
);

alter table neuro_priorities enable row level security;
alter table neuro_actions enable row level security;
alter table neuro_observations enable row level security;
alter table neuro_futures enable row level security;
alter table neuro_sleep enable row level security;
