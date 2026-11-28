-- Roll back multi-user isolation (phases 2 and 1). Run ONLY together with redeploying the pre-multi-user app
-- (git tag pre-multiuser-20261128). Removes invited accounts' rows, restores the single-owner keys, drops the new tables.
-- The owner's rows are kept as they are. Full copies of every table from before the change are in schema backup_mu_20261128.
begin;
do $$ declare t text; begin
  foreach t in array array['profile','memories','onboarding_answers','pledges','emergency_contacts','habits','habit_logs','convo_sessions','convo_turns',
    'sections','section_items','section_insights','section_metrics','push_subscriptions','notifications_sent','neuro_actions','neuro_futures',
    'neuro_observations','neuro_priorities','neuro_sleep','calendar_events','meeting_notes','bank_accounts','bank_transactions','balance_history',
    'merchant_rules','money_patterns','money_predictions','day_signals','phone_days','phone_events','passkeys'] loop
    execute format('delete from public.%I where user_id <> %L', t, 'e35a0000-0000-4000-8000-000000000001');
  end loop;
end $$;
alter table public.section_items drop constraint if exists section_items_section_fkey;
alter table public.section_insights drop constraint if exists section_insights_section_fkey;
alter table public.section_metrics drop constraint if exists section_metrics_section_fkey;
alter table public.sections drop constraint if exists sections_pkey;
alter table public.sections add constraint sections_pkey primary key (key);
alter table public.section_items add constraint section_items_section_fkey foreign key (section) references public.sections(key) on delete cascade;
alter table public.section_insights add constraint section_insights_section_fkey foreign key (section) references public.sections(key) on delete cascade;
alter table public.section_metrics add constraint section_metrics_section_fkey foreign key (section) references public.sections(key) on delete cascade;
alter table public.profile drop constraint if exists profile_pkey;
alter table public.profile add constraint profile_pkey primary key (key);
alter table public.notifications_sent drop constraint if exists notifications_sent_pkey;
alter table public.notifications_sent add constraint notifications_sent_pkey primary key (key);
alter table public.habits add constraint habits_name_key unique (name);
alter table public.convo_turns drop constraint if exists convo_turns_session_id_fkey;
alter table public.convo_sessions drop constraint if exists convo_sessions_pkey;
alter table public.convo_sessions add constraint convo_sessions_pkey primary key (id);
alter table public.convo_turns add constraint convo_turns_session_id_fkey foreign key (session_id) references public.convo_sessions(id) on delete cascade;
alter table public.push_subscriptions drop constraint if exists push_subscriptions_pkey;
alter table public.push_subscriptions add constraint push_subscriptions_pkey primary key (endpoint);
alter table public.convo_turns add constraint convo_turns_cid_key unique (cid);
do $$ declare t text; begin
  foreach t in array array['profile','memories','onboarding_answers','pledges','emergency_contacts','habits','habit_logs','convo_sessions','convo_turns',
    'sections','section_items','section_insights','section_metrics','push_subscriptions','notifications_sent','neuro_actions','neuro_futures',
    'neuro_observations','neuro_priorities','neuro_sleep','calendar_events','meeting_notes','bank_accounts','bank_transactions','balance_history',
    'merchant_rules','money_patterns','money_predictions','day_signals','phone_days','phone_events','passkeys'] loop
    execute format('alter table public.%I drop column if exists user_id', t);
  end loop;
end $$;
drop table if exists public.voice_usage;
drop table if exists public.invites;
drop table if exists public.app_users;
commit;
notify pgrst, 'reload schema';
