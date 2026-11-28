-- Multi-user isolation, phase 2 (run after the multi-user app is live). Lets two accounts own rows with the same
-- natural key: profile/sections/notifications keys, habit names, conversation turn ids. Owner data is untouched.
begin;
alter table public.profile drop constraint if exists profile_pkey;
alter table public.profile add constraint profile_pkey primary key using index profile_user_key_uq;

alter table public.habits drop constraint if exists habits_name_key;

alter table public.notifications_sent drop constraint if exists notifications_sent_pkey;
alter table public.notifications_sent add constraint notifications_sent_pkey primary key using index notifications_sent_user_uq;

alter table public.convo_turns drop constraint if exists convo_turns_cid_key;
alter table public.convo_turns drop constraint if exists convo_turns_session_id_fkey;
alter table public.convo_sessions drop constraint if exists convo_sessions_pkey;
alter table public.convo_sessions add constraint convo_sessions_pkey primary key using index convo_sessions_user_uq;
alter table public.convo_turns add constraint convo_turns_session_id_fkey foreign key (user_id, session_id) references public.convo_sessions(user_id, id) on delete cascade;

alter table public.push_subscriptions drop constraint if exists push_subscriptions_pkey;
alter table public.push_subscriptions add constraint push_subscriptions_pkey primary key using index push_subscriptions_user_uq;

alter table public.section_items drop constraint if exists section_items_section_fkey;
alter table public.section_insights drop constraint if exists section_insights_section_fkey;
alter table public.section_metrics drop constraint if exists section_metrics_section_fkey;
alter table public.sections drop constraint if exists sections_pkey;
alter table public.sections add constraint sections_pkey primary key using index sections_user_key_uq;
alter table public.section_items add constraint section_items_section_fkey foreign key (user_id, section) references public.sections(user_id, key) on delete cascade;
alter table public.section_insights add constraint section_insights_section_fkey foreign key (user_id, section) references public.sections(user_id, key) on delete cascade;
alter table public.section_metrics add constraint section_metrics_section_fkey foreign key (user_id, section) references public.sections(user_id, key) on delete cascade;

-- From now on every row must say whose it is (the app always sets it); a missing user_id is an error, not the owner.
do $$ declare t text; begin
  foreach t in array array['profile','memories','onboarding_answers','pledges','emergency_contacts','habits','habit_logs','convo_sessions','convo_turns',
    'sections','section_items','section_insights','section_metrics','push_subscriptions','notifications_sent','neuro_actions','neuro_futures',
    'neuro_observations','neuro_priorities','neuro_sleep','calendar_events','meeting_notes','bank_accounts','bank_transactions','balance_history',
    'merchant_rules','money_patterns','money_predictions','day_signals','phone_days','phone_events','passkeys'] loop
    execute format('alter table public.%I alter column user_id drop default', t);
  end loop;
end $$;
commit;
notify pgrst, 'reload schema';
