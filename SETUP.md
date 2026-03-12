# [SETUP.md](http://SETUP.md) — Updated Mar 12, 2026

Full installation walkthrough for Presence from scratch.

Prerequisites: macOS, Python 3.10+, Supabase account (free tier works), Anthropic API key, OpenAI API key (embeddings only — cheap), Chrome or Chromium.

---

## The Easy Way — Use MCP (Recommended)

Presence uses Supabase MCP natively. With it connected to Claude Code, you can skip most manual SQL steps — just describe what you want and Claude handles schema creation, migration, edge function deployment, and debugging.

**Connect Supabase MCP to Claude Code:**

1. In Claude Code settings, add the Supabase MCP server
2. Authenticate with your Supabase project
3. Claude can now directly read your schema, run migrations, execute SQL, and deploy edge functions against your live project

**What this unlocks:**

- "Create the memories table with the correct schema" → Claude reads the codebase and runs the migration
- "Deploy the gatekeeper edge function" → Claude runs `supabase functions deploy` with the right flags
- "Check why breadcrumbs stopped firing" → Claude queries `gatekeeper_runs` directly and reads the output
- "Add a column to activity_signal" → Claude writes and applies the migration, no copy-paste needed
- "Download the live edge functions and commit them" → Claude runs `supabase functions download` and stages the diff

For Notion docs: Connect Notion MCP the same way. Session handoffs, architecture decisions, and TODOs all live in Notion and Claude can read/write them directly during work sessions.

---

## 1. Create a Supabase project

Create a new project at [supabase.com](http://supabase.com). Note your:

- **Project URL** — `https://xxxxx.supabase.co`
- **anon key** — public, used by the Chrome extension
- **service role key** — secret, used by daemons and edge functions

---

## 2. Enable extensions

In Supabase Dashboard → Database → Extensions, enable:

- `vector`
- `pg_cron`

---

## 3. Run the schema

Run all of the following in the Supabase SQL editor, in order.

### Core tables

```sql
create table activity_signal (
  id bigserial primary key,
  user_id text,
  signal_type text not null,
  signal_value text,
  metadata jsonb default '{}',
  created_at timestamptz default now()
);
create index on activity_signal (created_at desc);

create table memories (
  id text primary key,
  user_id uuid not null,
  content text not null,
  memory_type text default 'user',
  cognitive_type text default 'observation',
  life_domain text,
  domain text,
  memory_class text,
  heat float default 0.5,
  vitality_score float default 0.5,
  pinned boolean default false,
  access_count int default 0,
  validation_count int default 0,
  embedding vector(1536),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table memory_compost (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  content text not null,
  vitality_at_death float,
  killed_by_content text,
  death_reason text,
  absorbed boolean default false,
  created_at timestamptz default now()
);

create table presence_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  message text not null,
  trigger_type text,
  read boolean default false,
  scored boolean default false,
  grade text,
  grade_reason text,
  reasoning text,
  context_memories text[],
  created_at timestamptz default now()
);

create table presence_gate (
  id bigserial primary key,
  status text not null,
  signal_count int,
  burst_detected boolean default false,
  last_signal_at timestamptz,
  last_fire_at timestamptz,
  detail text,
  created_at timestamptz default now()
);

create table presence_state (
  id int primary key default 1,
  current_mode text default 'away',
  mode_since timestamptz,
  last_fire_at timestamptz,
  last_fire_reason text,
  prime_directive text,
  directive_set_at timestamptz,
  updated_at timestamptz default now()
);
insert into presence_state (id) values (1) on conflict do nothing;

create table attention_digest (
  id bigserial primary key,
  user_id text,
  digest text not null,
  window_start timestamptz,
  window_end timestamptz,
  signal_count int,
  metadata jsonb default '{}',
  created_at timestamptz default now()
);

create table platform_memories (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  platform text not null,
  content text not null,
  first_seen_at timestamptz default now(),
  last_seen_at timestamptz default now(),
  removed_at timestamptz
);

create table trajectories (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  arcs text,
  tensions text,
  drift text,
  compressed text,
  memory_count int,
  memories_since_last int,
  is_active boolean default true,
  generated_at timestamptz default now(),
  superseded_at timestamptz
);

create table voice_embeddings (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default 'default',
  embedding float[] not null,
  sample_count int default 1,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table hearth_settings (
  key text primary key,
  value text,
  updated_at timestamptz default now()
);
insert into hearth_settings (key, value) values ('realtime_active', 'false') on conflict do nothing;

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  status text default 'running',
  triggered_by text,
  trigger_ref uuid,
  model text,
  requires_review boolean default false,
  input_envelope jsonb,
  output_envelope jsonb,
  payload jsonb,
  review_decision text,
  reviewed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz default now()
);

create table pending_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  signal_context jsonb,
  sonnet_reasoning text,
  trigger_reason text,
  mode_at_save text,
  expires_at timestamptz,
  consumed boolean default false,
  created_at timestamptz default now()
);

create table memory_cognitive_coverage (
  cognitive_type text not null,
  life_domain text not null,
  memory_count int default 0,
  last_updated timestamptz default now(),
  primary key (cognitive_type, life_domain)
);
```

### RPCs

```sql
create or replace function match_memories_for_competition(
  query_embedding vector(1536),
  match_user_id uuid,
  similarity_threshold float,
  match_count int
)
returns table (id text, content text, heat float, vitality_score float, similarity float)
language sql stable as $$
  select
    m.id, m.content, m.heat, m.vitality_score,
    1 - (m.embedding <=> query_embedding) as similarity
  from memories m
  where m.user_id = match_user_id
    and 1 - (m.embedding <=> query_embedding) > similarity_threshold
  order by similarity desc
  limit match_count;
$$;

create or replace function validate_memory(memory_id text)
returns void language plpgsql as $$
begin
  update memories
  set
    validation_count = validation_count + 1,
    vitality_score = least(vitality_score + 0.1, 1.0),
    updated_at = now()
  where id = memory_id;
end;
$$;

create or replace function get_diverse_memory_sample(
  p_user_id text,
  top_n integer default 15,
  diverse_n integer default 5
)
returns table (
  mem_id text,
  content text,
  cognitive_type text,
  life_domain text,
  vitality_score double precision,
  sample_reason text
)
language plpgsql as $$
declare
  resolved_user_id uuid;
  top_ids text[];
begin
  begin
    resolved_user_id := p_user_id::uuid;
  exception when invalid_text_representation then
    select m.user_id into resolved_user_id from memories m limit 1;
  end;

  if resolved_user_id is null then
    return;
  end if;

  select array_agg(sub.mem_id) into top_ids
  from (
    select m.id as mem_id from memories m
    where m.user_id = resolved_user_id
    order by m.vitality_score desc nulls last
    limit top_n
  ) sub;

  return query
  select m.id, m.content, m.cognitive_type, m.life_domain, m.vitality_score,
         'top_vitality'::text
  from memories m
  where m.user_id = resolved_user_id and m.id = any(top_ids);

  return query
  select distinct on (m.cognitive_type, coalesce(m.life_domain, 'unclassified'))
    m.id, m.content, m.cognitive_type, m.life_domain, m.vitality_score,
    'diversity_fill'::text
  from memories m
  left join memory_cognitive_coverage cov
    on  cov.cognitive_type = m.cognitive_type
    and cov.life_domain    = coalesce(m.life_domain, 'unclassified')
  where m.user_id = resolved_user_id
    and not (m.id = any(top_ids))
    and m.cognitive_type is not null
  order by
    m.cognitive_type,
    coalesce(m.life_domain, 'unclassified'),
    coalesce(cov.memory_count, 0) asc,
    m.vitality_score desc
  limit diverse_n;
end;
$$;
```

### Triggers

```sql
create or replace function sync_cognitive_coverage()
returns trigger language plpgsql as $$
begin
  delete from memory_cognitive_coverage;
  insert into memory_cognitive_coverage (cognitive_type, life_domain, memory_count, last_updated)
  select
    coalesce(cognitive_type, 'observation'),
    coalesce(life_domain, 'unclassified'),
    count(*),
    now()
  from memories
  group by cognitive_type, life_domain;
  return null;
end;
$$;

create trigger trg_sync_cognitive_coverage
after insert or update or delete on memories
for each statement execute function sync_cognitive_coverage();

create or replace function memory_safety_net_fn()
returns trigger language plpgsql as $$
begin
  if new.embedding is null then
    raise exception 'Memory must have an embedding';
  end if;
  if (select count(*) from memories where user_id = new.user_id) >= 77 then
    raise exception 'Memory shelf full — use admit-memory edge function';
  end if;
  return new;
end;
$$;

create trigger memory_safety_net
before insert on memories
for each row execute function memory_safety_net_fn();
```

### Scheduled jobs

```sql
-- Cleanup old activity signals hourly
select cron.schedule('cleanup_activity_signal', '0 * * * *',
  $$delete from activity_signal where created_at < now() - interval '24 hours'$$
);

-- Gatekeeper sweep every 60 seconds
-- Replace YOUR_PROJECT_REF and YOUR_SERVICE_ROLE_KEY before running
select cron.schedule('presence-gatekeeper-sweep', '* * * * *',
  $$select net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/presence-gatekeeper',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb,
    body := '{}'::jsonb
  )$$
);
-- Memory heat decay (4am UTC daily)
select cron.schedule('memory-heat-decay', '0 4 * * *',
  $$
  update memories set heat = heat - 0.05
  where heat > 0.1 and not pinned
    and (last_accessed is null or last_accessed < now() - interval '30 days');
  insert into memory_compost (content, type, domain, heat, death_reason)
  select content, type, domain, heat, 'heat_decay'
  from memories where heat <= 0.1 and not pinned;
  delete from memories where heat <= 0.1 and not pinned;
  $$
);
```

---

## 4. Set environment variables

In Supabase → Project Settings → Edge Functions → Secrets:

| Key | Value |
| --- | --- |
| `ANTHROPIC_API_KEY` | Your Anthropic key |
| `OPENAI_API_KEY` | Your OpenAI key |
| `SUPABASE_URL` | Auto-set by Supabase |
| `SUPABASE_ANON_KEY` | Auto-set by Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-set by Supabase |

---

## 5. Deploy edge functions

```bash
brew install supabase/tap/supabase
supabase login
cd /path/to/Presence
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy presence-gatekeeper --no-verify-jwt
supabase functions deploy admit-memory --no-verify-jwt
supabase functions deploy hearth-converse --no-verify-jwt
supabase functions deploy agent-scout --no-verify-jwt
supabase functions deploy process-intake --no-verify-jwt
```

**Note:** `--no-verify-jwt` is required. The gatekeeper is triggered by pg_cron with a service role key, not a user JWT. Functions without this flag will reject pg_cron calls with 401.

---

## 6. Install Python dependencies

```bash
pip3 install resemblyzer sounddevice numpy scipy requests python-dotenv \
             flask watchdog python-docx openpyxl pdfplumber openai faster-whisper
```

Create `daemons/.env`:

```
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
OPENAI_API_KEY=your_openai_key
```

---

## 7. Enroll your voice

Required for speaker filtering. The mic daemon uses your voiceprint to ignore other speakers.

```bash
cd daemons
python3 enroll_voice.py
```

Speak naturally for 10–15 seconds when prompted. Repeat once. Two samples produce a stable voiceprint.

Your embedding is stored in `voice_embeddings`. The listener classifies mic chunks as `user` (cosine > 0.75) or `other` using majority vote across buffered chunks.

---

## 8. Daemonize the realtime listener

The listener needs to survive sleep and restart on login. Use launchd:

```bash
cat > ~/Library/LaunchAgents/com.presence.realtime-listener.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.presence.realtime-listener</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>/ABSOLUTE/PATH/TO/daemons/realtime_listener.py</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SUPABASE_URL</key>
    <string>https://YOUR_PROJECT_REF.supabase.co</string>
    <key>SUPABASE_SERVICE_ROLE_KEY</key>
    <string>your_service_role_key</string>
    <key>OPENAI_API_KEY</key>
    <string>your_openai_key</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/presence-listener.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/presence-listener-error.log</string>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.presence.realtime-listener.plist
```

Find your Python path: `which python3`

Verify it loaded: `launchctl list | grep presence`

Check logs: `tail -f /tmp/presence-listener.log`

---

## 9. Start the file watcher daemon

```bash
python3 daemons/file_watcher_daemon.py
```

Runs on port 5556. The extension popup calls it to open a folder picker and start watching. You can daemonize it the same way as the realtime listener using a `com.presence.filewatcher.plist`.

---

## 10. Load the Chrome extension

1. Open Chrome → `chrome://extensions`
2. Enable Developer mode (top right toggle)
3. Click **Load unpacked**
4. Select the `Presence/extension/` directory (not the repo root)

The Presence panel appears in your Chrome toolbar.

---

## 11. Set your user ID

The edge functions use a hardcoded `user_id`. To use your own, find-and-replace this UUID across all five `supabase/functions/*/index.ts` files and redeploy:

```
95aa73e2-ac1a-4ac6-bfae-15a946b11131
```

---

## 12. Seed your identity model (onboarding intake)

The memory shelf starts empty. The system works from day one but gets meaningfully better once it has 20+ competed memories. The fastest way to seed it is to upload your existing AI conversation history — the onboarding flow extracts durable observations about how you think and work, then runs them through `admit-memory` so they compete for shelf slots just like live observations.

**How to export your history:**

- **Claude:** Settings → Account → Export Data → download the `.json` file
- **ChatGPT:** Settings → Data Controls → Export Data → download `conversations.json`

**How to upload:**

The panel has a built-in onboarding screen that appears on first load (before `onboarding_complete` is set in `hearth_settings`). It walks you through the file upload. If it doesn't appear, open the panel and look for the intake/upload screen — it's gated behind `setup_complete` and `onboarding_complete` checks.

**What happens:**

1. The file is parsed — Claude and ChatGPT export formats are both auto-detected
2. Your human messages are extracted and batched
3. Sonnet reads each batch and extracts up to 5 durable, specific observations per batch ("tends to prototype fast then seek external feedback", not "likes to think")
4. Each candidate is submitted through `admit-memory` — they compete for shelf slots, no shortcuts
5. `onboarding_complete = true` is written to `hearth_settings` when done
6. The panel returns a summary: messages found, candidates extracted, memories written/merged/discarded

**Expected result:** 20–60 memories seeded from a typical export. The system will have enough signal to generate a trajectory and start producing useful breadcrumbs within the first few hours of use.

---

## Using the panel

Once everything is running:

**Breadcrumbs** appear in the panel when the gatekeeper fires. Each one is one sentence or one question — a connection, a tension, or a gap.

**Grade every breadcrumb.** This is how the memory system learns what's signal and what's noise:

- **E** — exceptional. Boosts vitality of the source memories.
- **G** — good.
- **D** — didn't land.

**Prime Directive** — set your current focus lens from the panel. This reshapes what Presence notices without limiting what it watches. Clear it when done; this triggers compost resurrection.

**Realtime toggle** — enables/disables mic listening. The daemon runs either way; this just gates whether speech writes to `activity_signal`.

**Watch Folder** — opens a folder picker. Files in the watched folder write text diffs to `activity_signal` when changed.

**Expand** — deep-dives any breadcrumb through `hearth-converse`. Opus gives a 2–3 paragraph explanation using your full identity context.

---

## Verifying the system is working

Check that signals are flowing:

```sql
select signal_type, count(*), max(created_at)
from activity_signal
where created_at > now() - interval '1 hour'
group by signal_type
order by count desc;
```

Check gatekeeper sweep history:

```sql
select status, detail, created_at
from presence_gate
order by created_at desc
limit 20;
```

Check memory shelf:

```sql
select count(*), avg(vitality_score), max(vitality_score), min(vitality_score)
from memories;
```

Check trajectory:

```sql
select arcs, tensions, drift, memory_count, generated_at
from trajectories
where is_active = true
limit 1;
```
