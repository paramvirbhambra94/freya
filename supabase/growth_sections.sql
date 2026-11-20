-- Growth sections (Body, Connections, Mind & Deen, Work & Ambition, Vault). Additive only.
create table if not exists public.sections (
  key text primary key check (key in ('body','connections','mind','work','vault')),
  status text not null default 'onboarding' check (status in ('onboarding','building','ready')),
  answers jsonb not null default '[]'::jsonb,
  config jsonb,
  step int not null default 0,
  build_started_at timestamptz,
  ready_at timestamptz,
  attempts int not null default 0,
  last_error text,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists public.section_items (
  id uuid primary key default gen_random_uuid(),
  section text not null references public.sections(key) on delete cascade,
  kind text not null,                       -- photo | video | chat | text | reflection | file | note
  name text, mime text, bytes int,
  raw_path text,                            -- private bucket "growth"; deleted after 24h
  raw_text text,                            -- pasted text; wiped after 24h
  thumb_path text,                          -- Body progress-photo thumbnail (kept unless turned off)
  status text not null default 'uploading' check (status in ('uploading','pending','analysed','failed')),
  attempts int not null default 0,
  analysis jsonb,
  created_at timestamptz not null default now(),
  raw_expires_at timestamptz not null default now() + interval '24 hours',
  raw_deleted_at timestamptz
);
create index if not exists section_items_sec on public.section_items (section, created_at desc);
create index if not exists section_items_raw on public.section_items (raw_expires_at) where raw_path is not null or raw_text is not null;
create table if not exists public.section_insights (
  id bigint generated always as identity primary key,
  section text not null references public.sections(key) on delete cascade,
  item_id uuid references public.section_items(id) on delete set null,
  kind text not null default 'insight',     -- insight | question | review | compare | prep | welcome
  text text not null,
  data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists section_insights_sec on public.section_insights (section, created_at desc);
create table if not exists public.section_metrics (
  id bigint generated always as identity primary key,
  section text not null references public.sections(key) on delete cascade,
  key text not null, value numeric not null, unit text,
  item_id uuid references public.section_items(id) on delete set null,
  at timestamptz not null default now()
);
create index if not exists section_metrics_sec on public.section_metrics (section, key, at);
-- Server-only, like every other FREYA table: RLS on, no policies (only the secret key gets in).
alter table public.sections enable row level security;
alter table public.section_items enable row level security;
alter table public.section_insights enable row level security;
alter table public.section_metrics enable row level security;
-- Private bucket for raw uploads (10 MB cap per file; compressed on the phone first).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('growth', 'growth', false, 10485760, array['image/jpeg','image/png','image/webp','application/pdf','text/plain'])
on conflict (id) do nothing;
-- While a section is building, poke the builder every minute (no HTTP call at all otherwise).
select cron.schedule('freya-sections-build', '* * * * *', $$
  select net.http_post(url := 'https://freya-black.vercel.app/api/cron?only=sections',
    headers := jsonb_build_object('content-type','application/json','x-cron-secret',(select value from public.app_secrets where key = 'cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 60000)
  where exists (select 1 from public.sections where status = 'building')
$$);
