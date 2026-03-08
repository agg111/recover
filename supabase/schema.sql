-- Run this in the Supabase SQL editor

-- Injury profiles: stores Claude's analysis of uploaded injury photos
create table if not exists injury_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id text,  -- Supabase auth user id or anonymous session id
  image_url text,
  injury_type text,
  severity text,
  affected_area text,
  analysis jsonb,
  dos text[],
  donts text[],
  exercise_plan jsonb,
  created_at timestamptz default now()
);

-- Exercise sessions: stores user-uploaded exercise videos + NomadicML analysis
create table if not exists exercise_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  injury_profile_id uuid references injury_profiles(id) on delete set null,
  video_url text,
  exercise_name text,
  nomadicml_video_id text,
  nomadicml_analysis_id text,
  analysis_status text default 'pending', -- pending, processing, completed, failed
  raw_events jsonb,
  corrections jsonb,
  overall_score integer,
  feedback_summary text,
  created_at timestamptz default now()
);

-- Reminders: tracks all sent emails/reminders
create table if not exists reminders (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  injury_profile_id uuid references injury_profiles(id) on delete set null,
  email text not null,
  reminder_type text default 'exercise', -- exercise, followup, checkup
  scheduled_at timestamptz,
  sent_at timestamptz,
  resend_id text,
  created_at timestamptz default now()
);

-- Storage bucket for images and videos
insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do nothing;

-- Allow public read access to media bucket
create policy "Public read media" on storage.objects
  for select using (bucket_id = 'media');

-- Allow anyone to upload to media bucket (tighten with auth in production)
create policy "Anyone can upload media" on storage.objects
  for insert with check (bucket_id = 'media');
