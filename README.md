# Presence

**The proactive intelligence layer for AI. Watches how you work in real time and decides — on its own — whether something is worth interrupting you for.**

Everything being built right now in AI is reactive. You talk to it, it does a thing. Presence is the layer that's already watching, already noticing — and surfaces what matters without being summoned.

The hard problem isn't technical. It's knowing what's worth interrupting for. Get that wrong and users turn it off immediately. That filtering problem requires knowing the person deeply enough to distinguish signal from noise.

Identity is the engine. Presence is the proof. Current cost: ~$2/month.

---

## What it does

Four stages, every 60 seconds:

1. **Watches** — browser behavior, file changes, mic transcripts, AI interactions
2. **Classifies** — focused, fidgeting, or away
3. **Judges** — most potential output is rejected; silence is the default
4. **Synthesizes** — one sentence or one question: a connection, a tension, a gap you can't see from inside it

---

## Why this is different

Every competitor building "proactive AI" has your data but no model of your *now*. No cognitive state read. No taste about when to stay quiet. ChatGPT Pulse shipped and got shelved. Gemini Personal Intelligence optimizes for engagement. Perplexity Computer watches your files, not you.

What makes Presence different:

- **Competed identity model** — 77 memory slots. New observations beat incumbents to earn a place. The shelf stays load-bearing instead of bloating. What survives *is* the identity.
- **Diversity-aware sampling** — gatekeeper draws memories across `cognitive_type × life_domain` cells, not just top vitality. Pure meritocracy kills surprise; cross-domain tension requires shelf diversity.
- **Trajectory synthesis** — arcs, tensions, and drift extracted from the competed shelf. Shape emerges from competition, not explicit modeling.
- **Mode-tiered interrupt thresholds** — focused means earn the interrupt. Fidgeting is low bar. Away suppresses. The bar is the product.
- **Breadcrumb voice** — CUE, QUESTION, or INVITATION. One sentence max. The reasoning behind every fired breadcrumb is stored separately from the output.
- **The silence is the product** — 8,000+ gatekeeper sweeps run. Most produce nothing. That's working correctly.

---

## Architecture

```
Chrome extension
  └── activity_signal (tabs, scroll, searches, topic signals, file changes, mic)
        └── pg_cron (60s sweep)
              └── presence-gatekeeper (v66)
                    ├── Haiku novelty check (Layer 0)
                    ├── Sonnet judgment gate (Layer 1)
                    └── Opus breadcrumb synthesis (Layer 2, max_tokens 150)
                          ├── presence_notifications → extension popup
                          └── admit-memory → 77-slot competed shelf
                                └── trajectories (arcs, tensions, drift)

Daemons (launchd)
  ├── realtime_listener.py   → mic capture + speaker classification (resemblyzer)
  └── file_watcher_daemon.py → file changes with full text extraction (.docx, .pdf, .xlsx)

agent-scout (pg_cron, 8am/8pm)
  └── HN + GitHub + Reddit → Haiku analysis → activity_signal
```

---

## Repo structure

```
Presence/extension/
├── background.js                   # Extension service worker
├── manifest.json                   # Chrome MV3
├── content/content.js              # Page signal capture
├── panel/panel.html + panel.js     # Extension popup UI
├── platform-memory-scraper.js      # Claude.ai memory scraper
├── title-observer.js               # Tab title change observer
├── supabase/functions/
│   ├── presence-gatekeeper/        # Core sweep engine (v66)
│   ├── admit-memory/               # Memory competition gate
│   ├── hearth-converse/            # Expand-breadcrumb conversational interface
│   └── agent-scout/                # Competitive intelligence scanner
└── daemons/
    ├── realtime_listener.py        # Mic + speaker diarization
    ├── file_watcher_daemon.py      # File change detection
    └── enroll_voice.py             # Voice enrollment
```

---

## Cost

| Component | Frequency | ~Monthly |
|---|---|---|
| Haiku novelty check | Every 60s | ~$0.50 |
| Sonnet judgment gate | ~30% of sweeps | ~$1.00 |
| Opus breadcrumb synthesis | ~2–3 fires/day | ~$0.50 |
| Scout | 2x/day | ~$0.50 |
| **Total** | | **~$2/month** |

Cost scales only with Opus fire rate, not activity volume.

---

## Setup

Full installation: [SETUP.md](./SETUP.md)

Prerequisites: macOS, Python 3.10+, Node 18+, Supabase account, Anthropic API key, Chrome.

**Recommended:** Connect the [Supabase MCP](https://supabase.com/docs/guides/getting-started/mcp) to Claude Code. Schema creation, edge function deployment, and debugging become conversational rather than manual.

---

## Notes

- macOS + Chrome + Supabase. Linux possible with launchd adaptation.
- Single-user architecture. Multi-tenant path is designed, not yet built.
- The hardest part of this system is not signal collection. It is restraint.
