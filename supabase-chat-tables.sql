-- Run this in the Supabase SQL editor to enable chat persistence

create table if not exists chat_threads (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create table if not exists chat_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid references chat_threads(id) on delete cascade not null,
  user_id     text not null,
  role        text not null,      -- 'user' | 'assistant'
  content     text not null default '',
  metadata    jsonb default '{}', -- attachments, injury_card, video corrections, etc.
  created_at  timestamptz default now()
);

create index if not exists chat_messages_thread_id_idx on chat_messages(thread_id);
create index if not exists chat_messages_created_at_idx on chat_messages(created_at);
