-- Multi-user isolation, phase 1 (additive; safe with the previous app version still live).
-- Backs up every per-user table, adds app_users / invites / voice_usage, adds user_id to every per-user table
-- (existing rows are backfilled to the owner, Eesah), and adds (user_id, ...) unique indexes the new code upserts on.
-- Nothing existing is deleted or changed. Rollback: supabase/multi_user_rollback.sql
begin;
create schema if not exists backup_mu_20261128;
do $$ declare t text; begin
  foreach t in array array['profile','memories','onboarding_answers','pledges','emergency_contacts','habits','habit_logs','convo_sessions','convo_turns',
    'sections','section_items','section_insights','section_metrics','push_subscriptions','notifications_sent','neuro_actions','neuro_futures',
    'neuro_observations','neuro_priorities','neuro_sleep','calendar_events','meeting_notes','bank_accounts','bank_transactions','balance_history',
    'merchant_rules','money_patterns','money_predictions','day_signals','phone_days','phone_events','passkeys'] loop
    execute format('create table if not exists backup_mu_20261128.%I as table public.%I', t, t);
  end loop;
end $$;

create table if not exists public.app_users (
  id uuid primary key,
  name text not null,
  role text not null default 'tester' check (role in ('owner','tester')),
  status text not null default 'active' check (status in ('active','revoked')),
  voice_cap_min integer not null default 30,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
insert into public.app_users (id, name, role, status, voice_cap_min) values ('e35a0000-0000-4000-8000-000000000001', 'Eesah', 'owner', 'active', 0)
  on conflict (id) do nothing;
create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  name text not null,
  user_id uuid references public.app_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz
);
create table if not exists public.voice_usage (
  user_id uuid not null references public.app_users(id) on delete cascade,
  day date not null,
  seconds integer not null default 0,
  sessions integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.app_users enable row level security;
alter table public.invites enable row level security;
alter table public.voice_usage enable row level security;

do $$ declare t text; begin
  foreach t in array array['profile','memories','onboarding_answers','pledges','emergency_contacts','habits','habit_logs','convo_sessions','convo_turns',
    'sections','section_items','section_insights','section_metrics','push_subscriptions','notifications_sent','neuro_actions','neuro_futures',
    'neuro_observations','neuro_priorities','neuro_sleep','calendar_events','meeting_notes','bank_accounts','bank_transactions','balance_history',
    'merchant_rules','money_patterns','money_predictions','day_signals','phone_days','phone_events','passkeys'] loop
    execute format('alter table public.%I add column if not exists user_id uuid not null default %L references public.app_users(id) on delete cascade', t, 'e35a0000-0000-4000-8000-000000000001');
    execute format('create index if not exists %I on public.%I (user_id)', t || '_user_id_idx', t);
  end loop;
end $$;

-- Upsert targets used by the app (always prefixed with user_id).
create unique index if not exists profile_user_key_uq on public.profile (user_id, key);
create unique index if not exists sections_user_key_uq on public.sections (user_id, key);
create unique index if not exists habits_user_name_uq on public.habits (user_id, name);
create unique index if not exists habit_logs_user_uq on public.habit_logs (user_id, habit_id, day);
create unique index if not exists convo_sessions_user_uq on public.convo_sessions (user_id, id);
create unique index if not exists convo_turns_user_cid_uq on public.convo_turns (user_id, cid);
create unique index if not exists push_subscriptions_user_uq on public.push_subscriptions (user_id, endpoint);
create unique index if not exists notifications_sent_user_uq on public.notifications_sent (user_id, key);
create unique index if not exists meeting_notes_user_uq on public.meeting_notes (user_id, event_id);
create unique index if not exists calendar_events_user_uq on public.calendar_events (user_id, id);
create unique index if not exists money_predictions_user_uq on public.money_predictions (user_id, week_start, category, model);
create unique index if not exists money_patterns_user_uq on public.money_patterns (user_id, key);
create unique index if not exists day_signals_user_uq on public.day_signals (user_id, day);
create unique index if not exists bank_accounts_user_uq on public.bank_accounts (user_id, id);
create unique index if not exists balance_history_user_uq on public.balance_history (user_id, day, account_id);
create unique index if not exists merchant_rules_user_uq on public.merchant_rules (user_id, merchant_key);
create unique index if not exists bank_transactions_user_uq on public.bank_transactions (user_id, id);
create unique index if not exists phone_days_user_uq on public.phone_days (user_id, day);
commit;
notify pgrst, 'reload schema';
