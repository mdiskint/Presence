# Presence

**A proactive AI identity layer that watches behavioral signals and speaks only when silence stops being the right answer.**

Default: silence. The system earns the right to interrupt.

---

## What this is

Presence runs as a Chrome extension + background daemons. Every 60 seconds, a gatekeeper sweeps your recent behavioral signals (active tabs, mic audio, open files) and decides whether anything warrants surfacing — not as a notification, but as a *breadcrumb*: a timed, typed observation from Opus. Most sweeps produce nothing. That's the feature.

The identity model lives in Supabase: 77 memory slots, heat-weighted, competition-gated. New observations must beat incumbents to earn a place. The shelf stays load-bearing instead of bloating.

---

## Architecture

```
Chrome extension
  └── content scripts → activity_signal table (tabs, title, mic)
  └── panel UI        → reads presence_notifications

pg_cron (60s)
  └── presence-gatekeeper Edge Function
        ├── Haiku novelty check (Layer 0, ~$0.0002/call)
        ├── Sonnet judgment gate (Layer 1)
        └── Opus breadcrumb synthesis (Layer 2, max_tokens 150)
              └── writes to presence_notifications

pg_cron (8am/8pm)
  └── Scout (signal surface, not trigger)

pg_cron (4am UTC)
  └── Memory heat decay (compost below 0.1 heat)

Daemons (launchd)
  └── realtime_listener.py  → writes mic/voice signals
  └── filewatcher           → writes file activity signals
```

---

## Prerequisites

- macOS (daemons use launchd)
- Node.js 18+
- Python 3.10+
- [Supabase CLI](https://supabase.com/docs/guides/cli) — `brew install supabase/tap/supabase`
- [Claude Code](https://claude.ai/code) — used for all deployment and schema work
- Supabase account (free tier works)
- Anthropic API key

---

## Setup

### The Easy Way — Use MCP (Recommended)

Presence uses [Supabase MCP](https://supabase.com/docs/guides/getting-started/mcp) and [Notion MCP](https://www.notion.so/help/notion-ai-mcp) natively. With these connected to Claude Code, you can skip most manual SQL steps — just describe what you want and Claude handles schema creation, migration, edge function deployment, and debugging.

**Connect Supabase MCP to Claude Code:**

1. In Claude Code settings, add the Supabase MCP server
2. Authenticate with your Supabase project
3. Claude can now directly read your schema, run migrations, execute SQL, and deploy edge functions against your live project

**What this unlocks:**
- "Create the memories table with the correct schema" → Claude reads the codebase and runs the migration
- "Deploy the gatekeeper edge function" → Claude runs `supabase functions deploy` with the right flags
- "Check why breadcrumbs stopped firing" → Claude queries `gatekeeper_runs` directly and reads the output
- "Add a column to activity_signal" → Claude writes and applies the migration, no copy-paste needed

**For Notion docs:** Connect Notion MCP the same way. Session handoffs, architecture decisions, and TODOs all live in Notion and Claude can read/write them directly during work sessions.

---

### Step 1 — Supabase Project

1. Create a new project at [supabase.com](https://supabase.com)
2. Note your **Project ID** (looks like `abcdefghijklmnop`) and **anon key`
3. Enable the `pgvector` extension: Database → Extensions → search "vector" → enable

---

### Step 2 — Schema

Run these migrations in order via the Supabase SQL editor, or have Claude Code run them via MCP.

#### Core tables

```sql
-- Enable pgvector
create extension if not exists vector;

-- Activity signals (what the extension watches)
create table activity_signal (
  id bigserial primary key,
  user_id text,
  signal_type text not null,
  signal_value text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on activity_signal (created_at desc);

-- Identity model (the memory shelf)
create table memories (
  id text primary key default gen_random_uuid()::text,
  content text not null,
  type text not null default 'user',
  domain text not null default 'unknown',
  emotion text,
  heat float not null default 0.5,
  vitality_score float default 0.5,
  cognitive_type text default 'observation', -- observation/connection/tension/question/principle
  embedding vector(1536),
  pinned boolean default false,
  access_count int default 0,
  last_accessed timestamptz,
  validation text not null default 'untested',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Breadcrumbs (what Presence surfaces)
create table presence_notifications (
  id uuid primary key default gen_random_uuid(),
  message text not null,
  reasoning text,                    -- why Opus fired this
  trigger_type text not null,
  trigger_context text,
  trigger_signal_excerpt text,
  context_memories uuid[] default '{}',
  oracle_confidence real,
  oracle_signal_type text,
  read boolean not null default false,
  scored boolean not null default false,
  outcome text,
  grade_reason text,
  grade_timing boolean,
  grade_insight text,
  grade_clarity boolean,
  graded_at timestamptz,
  created_at timestamptz not null default now()
);

-- Gatekeeper audit log
create table gatekeeper_runs (
  id uuid primary key default gen_random_uuid(),
  run_at timestamptz default now(),
  signals_processed int default 0,
  mode_classified text,
  sonnet_decision text,
  opus_fired boolean default false,
  notes text
);

-- Settings (prime directive, thresholds, etc.)
create table hearth_settings (
  key text primary key,
  value text,
  updated_at timestamptz default now()
);

-- Memory compost (evicted memories, searchable for resurrection)
create table memory_compost (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  type text,
  domain text,
  heat float,
  vitality_at_death float,
  killed_by_content text,
  death_reason text,
  composted_at timestamptz default now(),
  absorbed boolean default false
);

-- Voice speaker embeddings
create table voice_embeddings (
  id serial primary key,
  user_id text not null default 'default',
  embedding float[] not null,
  sample_count int not null default 1,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Narrative trajectories (Scout output)
create table trajectories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  arcs text not null,
  tensions text not null,
  drift text not null,
  compressed text not null,
  memory_count int not null,
  memories_since_last int,
  is_active boolean default true,
  generated_at timestamptz default now(),
  superseded_at timestamptz
);
```

#### Initial settings

```sql
insert into hearth_settings (key, value) values
  ('prime_directive', 'Be present.'),
  ('memory_shelf_limit', '77'),
  ('gatekeeper_enabled', 'true'),
  ('breadcrumb_voice', 'CUE');
```

---

### Step 3 — pg_cron jobs

Enable pg_cron: Database → Extensions → enable `pg_cron`.

```sql
-- Main gatekeeper sweep (every 60 seconds)
select cron.schedule(
  'presence-gatekeeper',
  '* * * * *',
  $$select net.http_post(
    url := 'https://<your-project-id>.supabase.co/functions/v1/presence-gatekeeper',
    headers := '{"Authorization": "Bearer <your-service-role-key>", "Content-Type": "application/json"}',
    body := '{}'
  )$$
);

-- Scout runs (8am and 8pm)
select cron.schedule('presence-scout-am', '0 8 * * *',
  $$select net.http_post(url := 'https://<your-project-id>.supabase.co/functions/v1/presence-scout', ...)$$
);
select cron.schedule('presence-scout-pm', '0 20 * * *',
  $$select net.http_post(url := 'https://<your-project-id>.supabase.co/functions/v1/presence-scout', ...)$$
);

-- Memory heat decay (4am UTC)
select cron.schedule('memory-heat-decay', '0 4 * * *',
  $$
  update memories set heat = heat - 0.05
  where heat > 0.1
    and not pinned
    and (last_accessed is null or last_accessed < now() - interval '30 days');
  
  insert into memory_compost (content, type, domain, heat, death_reason)
  select content, type, domain, heat, 'heat_decay'
  from memories where heat <= 0.1 and not pinned;
  
  delete from memories where heat <= 0.1 and not pinned;
  $$
);
```

---

### Step 4 — Edge Functions

Deploy via Supabase CLI (Claude Code can run this directly via MCP or terminal):

```bash
cd ~/Dropbox/Claude_Work/Presence/extension

supabase functions deploy presence-gatekeeper --no-verify-jwt
supabase functions deploy presence-scout --no-verify-jwt
supabase functions deploy admit-memory --no-verify-jwt
```

**Note:** `--no-verify-jwt` is required. The gatekeeper is triggered by pg_cron with a service role key, not a user JWT.

Set function secrets:

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set SUPABASE_URL=https://<your-project-id>.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
```

---

### Step 5 — Chrome Extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select `~/Dropbox/Claude_Work/Presence/extension`

The extension needs your Supabase URL and anon key. Set them in the extension popup on first load, or edit `manifest.json` directly.

**Current known issue:** `hearth_settings` references exist in `background.js` and `panel.js` — this is the canonical table name and is correct. Any `presence_settings` references are stale and need updating.

---

### Step 6 — Daemons

The realtime listener captures mic audio and classifies speaker via voice enrollment.

```bash
# Install Python deps
pip3 install resemblyzer sounddevice numpy supabase

# Load the realtime listener daemon
cp daemons/com.presence.realtime-listener.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.presence.realtime-listener.plist

# Load the file watcher daemon
cp daemons/com.presence.filewatcher.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.presence.filewatcher.plist

# Verify both are running
launchctl list | grep presence
```

**Voice enrollment:** The system needs 6–8 voice samples to reach the 0.75 cosine similarity threshold. Run the enrollment script from `scripts/`:

```bash
python3 scripts/enroll_voice.py
```

---

## Configuration

| Setting | Table | Key | Default |
|---|---|---|---|
| Prime directive | `hearth_settings` | `prime_directive` | "Be present." |
| Memory shelf limit | `hearth_settings` | `memory_shelf_limit` | 77 |
| Gatekeeper on/off | `hearth_settings` | `gatekeeper_enabled` | true |
| Breadcrumb voice | `hearth_settings` | `breadcrumb_voice` | CUE |

**Breadcrumb voice types:**
- `CUE` — terse signal, pattern or shift only
- `QUESTION` — surface a tension the user hasn't named
- `INVITATION` — open a thread worth pulling

Change the prime directive any time via the extension panel. Memory compost items that were suppressed under the old directive are eligible for resurrection under the new one.

---

## Observability

With Supabase MCP in Claude Code, ask directly:

- "How many breadcrumbs fired today and what were their grades?" → queries `presence_notifications`
- "What did the last 10 gatekeeper sweeps decide?" → queries `gatekeeper_runs`
- "What's the current memory shelf state?" → queries `memories` ordered by heat
- "Show me composted memories from this week" → queries `memory_compost`

Without MCP, use the Supabase Table Editor or SQL editor.

---

## Cost

| Component | Frequency | Est. monthly |
|---|---|---|
| Haiku novelty check | Every 60s | ~$0.50 |
| Sonnet judgment | ~30% of sweeps | ~$1.00 |
| Opus breadcrumb | Only when Sonnet fires | ~$0.50 |
| Scout | 2x/day | ~$0.50 |
| **Total** | | **~$2–3/month** |

Costs scale only with Opus fire rate, not with user activity volume.

---

## Known Issues

- `platform_memories` scraper broken (wrong DOM selectors) — pipeline is wired correctly, data is not flowing
- ChatGPT and Gemini conversation scrapers not built — Claude.ai works via network interception
- D-grade breadcrumbs don't currently decay vitality of contributing memories
- Newly inserted memories land with `vitality_score = NULL` in some paths (admit-memory only writes `heat`)
- Voice enrollment needs 3–4 more runs at similarity threshold (currently ~0.59 vs. 0.75 target)
- Site opt-out / blocked-domains feature not yet built
- Transcribe watcher not yet daemonized

---

## Repo Structure

```
extension/
├── background.js          # Extension service worker, signal capture
├── manifest.json          # Chrome extension manifest
├── panel.js               # Breadcrumb panel UI
├── platform-memory-scraper.js  # Claude.ai memory scraper (partially working)
├── title-observer.js      # Tab title change observer
├── content/               # Content scripts
├── icons/                 # Extension icons
├── panel/                 # Panel HTML/CSS
├── scripts/               # Python utilities (voice enrollment, etc.)
├── daemons/               # launchd plist files
└── supabase/
    └── functions/         # Edge functions (gatekeeper, scout, admit-memory)
```

---

## Philosophy

One selection pressure: **default to silence, earn the right to exist.**

This single constraint generates every behavior — memory competition, notification gating, the SILENCE default, the governance layer. The system is a minimal substrate. The work is observing what emerges.

Presence is not an assistant. Not a conscience. It's the pattern-recognition faculty that sees things before conscious articulation can catch up — externalized....cd ~/Dropbox/Claude_Work/Presence/extension
cp /path/to/README.md ./README.md
git add README.md
git commit -m "add setup README with MCP-first onboarding"
git push
