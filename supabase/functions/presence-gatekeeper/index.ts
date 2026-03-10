import Anthropic from "npm:@anthropic-ai/sdk";

type Json = Record<string, unknown>;

type Mode = "focused" | "fidgeting" | "away";
type GateStatus = "accumulating" | "fired" | "suppressed";

interface PresenceStateRow {
  id: number;
  current_mode: Mode;
  mode_since: string | null;
  last_fire_at: string | null;
  last_fire_reason: string | null;
  updated_at: string | null;
}

interface SignalRow {
  id?: number;
  user_id?: string | null;
  signal_type?: string | null;
  signal_value?: string | null;
  metadata?: Json | null;
  created_at?: string | null;
}

interface AttentionDigestResult {
  digest: string;
  metadata: Json;
}

interface OpusSynthesisResult {
  message: string;
  reasoning: string | null;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const MODEL_OPUS = "claude-opus-4-6";

const MODE_WINDOW_MINUTES = 5;
const FALLBACK_ACTIVITY_HOURS = 2;
const MIN_FIRE_GAP_MINUTES = 10;
const MAX_ATTENTION_DIGEST_CHARS = 1000;
const MAX_FOCUS_GAP_MINUTES = 10;

const USER_ID = "95aa73e2-ac1a-4ac6-bfae-15a946b11131";

const AI_DOMAINS = new Set([
  "claude.ai",
  "chatgpt.com",
  "chat.openai.com",
  "gemini.google.com",
  "perplexity.ai",
  "poe.com",
  "copilot.microsoft.com",
]);

const SYSTEM_INSTRUCTION = [
  "You are a presence system — not an assistant, not a reminder app, not a coach.",
  "",
  "You have access to this person's identity (memories, trajectory) and current context (calendar-free realtime signals).",
  "Your job is to notice what they can't see from inside their own momentum.",
  "When user_message signals are present, treat them as the highest-fidelity indicator of current thinking, weighting them above navigation and tab signals.",
  "",
  "WHAT TO SURFACE (in order of value):",
  "1. LEVERAGE — A connection between two things they're working on that they haven't linked yet.",
  "2. SERENDIPITY — Something in context that creates an unexpected opening.",
  "3. CONTRADICTION — Two active commitments pulling in different directions.",
  "4. SILENCE — If nothing above clears the bar, return exactly: SILENCE",
  "",
  "WHAT NEVER TO SURFACE:",
  "- reminders or to-dos",
  "- guilt framing",
  "- generic encouragement",
  "",
  "TONE AND STRUCTURE:",
  "2-3 sentences max. No preamble. Direct, specific, and concrete.",
  "Never ask a question. State the connection clearly.",
].join("\n");

function jsonHeaders(): HeadersInit {
  return {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}

async function dbSelect(table: string, query: string): Promise<Json[]> {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const resp = await fetch(url, { method: "GET", headers: jsonHeaders() });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`dbSelect ${table} failed (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  return Array.isArray(data) ? (data as Json[]) : [];
}

async function dbInsert(table: string, rows: Json | Json[]): Promise<void> {
  const payload = Array.isArray(rows) ? rows : [rows];
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { ...jsonHeaders(), "Prefer": "return=minimal" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`dbInsert ${table} failed (${resp.status}): ${text}`);
  }
}

async function dbUpsert(table: string, rows: Json | Json[]): Promise<void> {
  const payload = Array.isArray(rows) ? rows : [rows];
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      ...jsonHeaders(),
      "Prefer": "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`dbUpsert ${table} failed (${resp.status}): ${text}`);
  }
}

async function dbUpdate(table: string, filter: string, patch: Json): Promise<void> {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${filter}`;
  const resp = await fetch(url, {
    method: "PATCH",
    headers: { ...jsonHeaders(), "Prefer": "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`dbUpdate ${table} failed (${resp.status}): ${text}`);
  }
}

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  const dt = new Date(String(value));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function minutesSince(value: unknown): number {
  const dt = parseDate(value);
  if (!dt) return Number.POSITIVE_INFINITY;
  return (Date.now() - dt.getTime()) / 60_000;
}

function response(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function extractDomain(signal: SignalRow): string {
  const meta = signal.metadata;
  if (meta && typeof meta === "object") {
    const domain = String((meta as Json).domain ?? (meta as Json).hostname ?? "").trim().toLowerCase();
    if (domain) return domain;
    const urlRaw = String((meta as Json).url ?? "").trim();
    if (urlRaw) {
      try {
        return (new URL(urlRaw).hostname || "").toLowerCase();
      } catch {
        // ignore
      }
    }
  }
  const value = String(signal.signal_value ?? "").trim();
  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      return (new URL(value).hostname || "").toLowerCase();
    } catch {
      // ignore
    }
  }
  return "";
}

function isAiDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (AI_DOMAINS.has(d)) return true;
  for (const base of AI_DOMAINS) {
    if (d.endsWith(`.${base}`)) return true;
  }
  return false;
}

function sortSignalsAsc(signals: SignalRow[]): SignalRow[] {
  return [...signals].sort((a, b) => {
    const ta = parseDate(a.created_at)?.getTime() ?? 0;
    const tb = parseDate(b.created_at)?.getTime() ?? 0;
    return ta - tb;
  });
}

function classifyMode(signals: SignalRow[]): { mode: Mode; reason: string } {
  const count = signals.length;
  if (count < 3) {
    return { mode: "away", reason: `Only ${count} signals in last ${MODE_WINDOW_MINUTES}m` };
  }

  const domains = signals.map(extractDomain).filter(Boolean);
  const uniqueDomains = new Set(domains);
  const uniqueCount = uniqueDomains.size;

  const hasSearch = signals.some((s) => String(s.signal_type ?? "").toLowerCase() === "search");
  const hasAiTopic = signals.some((s) => String(s.signal_type ?? "").toLowerCase() === "ai_topic");

  const tabFocus = sortSignalsAsc(
    signals.filter((s) => String(s.signal_type ?? "").toLowerCase() === "tab_focus"),
  );

  const nowMs = Date.now();
  const dwells: number[] = [];
  let engagedCount = 0;
  let glanceCount = 0;
  let bounceCount = 0;
  for (let i = 0; i < tabFocus.length; i++) {
    const currentTs = parseDate(tabFocus[i].created_at)?.getTime();
    if (!currentTs) continue;
    let dwellSeconds = 0;
    if (i < tabFocus.length - 1) {
      const nextTs = parseDate(tabFocus[i + 1].created_at)?.getTime();
      if (nextTs) {
        dwellSeconds = Math.max(0, (nextTs - currentTs) / 1000);
      }
    } else {
      dwellSeconds = Math.max(0, (nowMs - currentTs) / 1000);
    }
    dwells.push(dwellSeconds);
    if (dwellSeconds >= 60) {
      engagedCount += 1;
    } else if (dwellSeconds >= 10) {
      glanceCount += 1;
    } else {
      bounceCount += 1;
    }
  }

  const gapsSeconds: number[] = [];
  for (let i = 1; i < tabFocus.length; i++) {
    const prev = parseDate(tabFocus[i - 1].created_at);
    const curr = parseDate(tabFocus[i].created_at);
    if (!prev || !curr) continue;
    gapsSeconds.push((curr.getTime() - prev.getTime()) / 1000);
  }
  const medianGap = median(gapsSeconds);

  const tabDomains = tabFocus.map(extractDomain).filter(Boolean);
  const tabUniqueCount = new Set(tabDomains).size;

  let aiAlternations = 0;
  let transitions = 0;
  for (let i = 1; i < tabDomains.length; i++) {
    const prevAi = isAiDomain(tabDomains[i - 1]);
    const currAi = isAiDomain(tabDomains[i]);
    if (prevAi !== currAi) aiAlternations += 1;
    transitions += 1;
  }
  const altRatio = transitions > 0 ? aiAlternations / transitions : 0;
  const hasAiAndNonAi = tabDomains.some((d) => isAiDomain(d)) && tabDomains.some((d) => !isAiDomain(d));

  const shortDwellScatter = tabUniqueCount >= 4 && tabFocus.length >= 4 && medianGap > 0 && medianGap < 30;
  const aiBouncePattern = tabFocus.length >= 4 && hasAiAndNonAi && altRatio >= 0.6;
  const mostTabsBounce = tabFocus.length > 0 && bounceCount >= Math.ceil(tabFocus.length * 0.6);
  const fastBouncePattern = medianGap > 0 && medianGap < 10 && mostTabsBounce;
  const looksFidgetingSecondary = shortDwellScatter || aiBouncePattern || fastBouncePattern;
  const looksFocusedSecondary = hasSearch || hasAiTopic || uniqueCount <= 3;

  const passiveDomains = new Set(['youtube.com', 'www.youtube.com', 'netflix.com', 'twitch.tv', 'hulu.com', 'disneyplus.com', 'max.com', 'peacocktv.com']);

  const scrollSignals = signals.filter(s => String(s.signal_type ?? '').toLowerCase() === 'scroll_depth');
  if (scrollSignals.length > 0) {
    const recent = scrollSignals.slice(-3);
    const avgDepth = recent.reduce((sum, s) => sum + Number((s.metadata as any)?.scroll_depth_pct ?? 0), 0) / recent.length;
    const avgTime = recent.reduce((sum, s) => sum + Number((s.metadata as any)?.time_on_page_seconds ?? 0), 0) / recent.length;
    const onPassiveDomain = recent.some(s => passiveDomains.has(String((s.metadata as any)?.domain ?? '')));
    if (avgDepth < 15 && avgTime > 60 && onPassiveDomain) {
      return { mode: 'fidgeting' as Mode, reason: `Passive consumption detected: avg_depth=${avgDepth.toFixed(0)}%, avg_time=${avgTime.toFixed(0)}s on ${recent.map(s => (s.metadata as any)?.domain).filter(Boolean)[0]}` };
    }
  }

  if (engagedCount >= 2) {
    return {
      mode: "focused",
      reason:
        `Dwell-primary focused: engaged=${engagedCount}, glance=${glanceCount}, bounce=${bounceCount}, ` +
        `median_tab_gap=${medianGap.toFixed(1)}s, unique_domains=${uniqueCount}`,
    };
  }

  if (engagedCount <= 1 && bounceCount >= 3) {
    return {
      mode: "fidgeting",
      reason:
        `Dwell-primary fidgeting: engaged=${engagedCount}, glance=${glanceCount}, bounce=${bounceCount}, ` +
        `median_tab_gap=${medianGap.toFixed(1)}s, ai_alt_ratio=${altRatio.toFixed(2)}`,
    };
  }

  if (looksFidgetingSecondary) {
    return {
      mode: "fidgeting",
      reason:
        `Secondary fidgeting: engaged=${engagedCount}, bounce=${bounceCount}, unique_domains=${uniqueCount}, ` +
        `median_tab_gap=${medianGap.toFixed(1)}s, ai_alt_ratio=${altRatio.toFixed(2)}`,
    };
  }

  if (looksFocusedSecondary && engagedCount >= 1) {
    return {
      mode: "focused",
      reason:
        `Secondary focused: engaged=${engagedCount}, glance=${glanceCount}, bounce=${bounceCount}, ` +
        `search=${hasSearch}, ai_topic=${hasAiTopic}, unique_domains=${uniqueCount}`,
    };
  }

  return {
    mode: engagedCount >= 1 ? "focused" : "fidgeting",
    reason:
      `Fallback mode: engaged=${engagedCount}, glance=${glanceCount}, bounce=${bounceCount}, ` +
      `unique_domains=${uniqueCount}, median_tab_gap=${medianGap.toFixed(1)}s`,
  };
}

function detectTransition(oldMode: Mode, newMode: Mode): { changed: boolean; transition: string; triggersStage3: boolean } {
  if (oldMode === newMode) {
    return { changed: false, transition: `${oldMode} -> ${newMode}`, triggersStage3: false };
  }

  const transition = `${oldMode} -> ${newMode}`;
  const meaningful = (
    (oldMode === "focused" && newMode === "fidgeting") ||
    (oldMode === "focused" && newMode === "away") ||
    (oldMode === "away" && newMode === "focused")
  );

  return {
    changed: true,
    transition,
    triggersStage3: meaningful,
  };
}

async function readPresenceState(): Promise<PresenceStateRow> {
  const rows = await dbSelect(
    "presence_state",
    "select=id,current_mode,mode_since,last_fire_at,last_fire_reason,updated_at&id=eq.1&limit=1",
  );

  if (rows.length) {
    const row = rows[0];
    return {
      id: Number(row.id ?? 1),
      current_mode: String(row.current_mode ?? "away") as Mode,
      mode_since: row.mode_since ? String(row.mode_since) : null,
      last_fire_at: row.last_fire_at ? String(row.last_fire_at) : null,
      last_fire_reason: row.last_fire_reason ? String(row.last_fire_reason) : null,
      updated_at: row.updated_at ? String(row.updated_at) : null,
    };
  }

  const nowIso = new Date().toISOString();
  await dbUpsert("presence_state", {
    id: 1,
    current_mode: "away",
    mode_since: nowIso,
    last_fire_at: null,
    last_fire_reason: null,
    updated_at: nowIso,
  });

  return {
    id: 1,
    current_mode: "away",
    mode_since: nowIso,
    last_fire_at: null,
    last_fire_reason: null,
    updated_at: nowIso,
  };
}

async function updatePresenceState(patch: Partial<PresenceStateRow>): Promise<void> {
  const body: Json = { updated_at: new Date().toISOString() };
  if (patch.current_mode !== undefined) body.current_mode = patch.current_mode;
  if (patch.mode_since !== undefined) body.mode_since = patch.mode_since;
  if (patch.last_fire_at !== undefined) body.last_fire_at = patch.last_fire_at;
  if (patch.last_fire_reason !== undefined) body.last_fire_reason = patch.last_fire_reason;

  await dbUpdate("presence_state", "id=eq.1", body);
}

async function logGate(
  status: GateStatus,
  signalCount: number,
  detail: string,
  options?: { burstDetected?: boolean; lastSignalAt?: string; lastFireAt?: string | null },
): Promise<void> {
  await dbInsert("presence_gate", {
    status,
    signal_count: signalCount,
    burst_detected: options?.burstDetected ?? false,
    last_signal_at: options?.lastSignalAt ?? new Date().toISOString(),
    last_fire_at: options?.lastFireAt ?? null,
    detail,
  });
}

async function logGatekeeperRun(
  signalsProcessed: number,
  modeClassified: string,
  sonnetDecision: string,
  opusFired: boolean,
  notes: string,
): Promise<void> {
  await dbInsert("gatekeeper_runs", {
    run_at: new Date().toISOString(),
    signals_processed: signalsProcessed,
    mode_classified: modeClassified,
    sonnet_decision: sonnetDecision,
    opus_fired: opusFired,
    notes,
  });
}

function compressSignalsForNovelty(signals: SignalRow[]): string {
  return signals
    .map((s) => {
      const t = String(s.signal_type ?? "").trim();
      const v = String(s.signal_value ?? "").trim().slice(0, 120);
      return `${t}: ${v}`;
    })
    .join("\n")
    .slice(0, 2000);
}

async function checkNovelty(
  currentSignals: SignalRow[],
): Promise<{ novel: boolean; reason: string }> {
  // Find the last time Sonnet actually ran
  const lastSonnetRuns = await dbSelect(
    "gatekeeper_runs",
    "select=run_at&sonnet_decision=not.like.skip_*&sonnet_decision=neq.error&order=run_at.desc&limit=1",
  );

  if (!lastSonnetRuns.length) {
    return { novel: true, reason: "No prior Sonnet evaluation — first run" };
  }

  const lastRunAt = String(lastSonnetRuns[0].run_at ?? "");
  const lastWindowStart = new Date(new Date(lastRunAt).getTime() - MODE_WINDOW_MINUTES * 60_000).toISOString();

  // Fetch the signals Sonnet saw last time
  const prevSignalsRaw = await dbSelect(
    "activity_signal",
    `select=signal_type,signal_value&created_at=gte.${encodeURIComponent(lastWindowStart)}&created_at=lte.${encodeURIComponent(lastRunAt)}&order=created_at.asc&limit=500`,
  );
  const prevSignals = prevSignalsRaw as SignalRow[];

  const prevCompressed = compressSignalsForNovelty(prevSignals);
  const currentCompressed = compressSignalsForNovelty(currentSignals);

  if (prevCompressed === currentCompressed) {
    return { novel: false, reason: "Signal content identical to last Sonnet window" };
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const prompt = `You are a novelty detector for an attention system. Given the signals from the PREVIOUS evaluation and the CURRENT signals, has anything meaningfully new entered the context that wasn't present before?

Meaningful change includes: new topics, new searches, new domains, shift in activity pattern.
NOT meaningful: same pages with updated timestamps, minor scroll changes, same tabs in different order.

[PREVIOUS SIGNALS]
${prevCompressed}

[CURRENT SIGNALS]
${currentCompressed}

Reply ONLY with JSON: {"novel": true/false, "reason": "one sentence"}`;

  const resp = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(raw) as Json;
    return {
      novel: Boolean(parsed.novel),
      reason: String(parsed.reason ?? "No reason provided"),
    };
  } catch {
    // If Haiku fails to parse, default to novel (don't block Sonnet)
    return { novel: true, reason: `Haiku parse fallback: ${raw.slice(0, 100)}` };
  }
}

function formatMemories(memories: Json[]): string {
  if (!memories.length) return "(none)";
  return memories
    .map((m) => {
      const domain = String(m.domain ?? m.life_domain ?? "Unknown");
      const memoryClass = String(m.memory_class ?? m.sample_reason ?? "unknown");
      const cognitiveType = String(m.cognitive_type ?? "observation");
      const content = String(m.content ?? "").trim();
      return `- [${domain}/${memoryClass}/${cognitiveType}] ${content}`;
    })
    .join("\n");
}

function formatTrajectory(trajectory: Json | null): string {
  if (!trajectory) return "(none)";
  return [
    `ARCS: ${JSON.stringify(trajectory.arcs ?? [])}`,
    `TENSIONS: ${JSON.stringify(trajectory.tensions ?? [])}`,
    `DRIFT: ${String(trajectory.drift ?? "(none)")}`,
  ].join("\n");
}

function formatActivity(activityRows: Json[]): string {
  if (!activityRows.length) return "(none)";
  return activityRows
    .map((row) => {
      const signalType = String(row.signal_type ?? "unknown");
      const signalValue = String(row.signal_value ?? "").slice(0, 180);
      const createdAt = String(row.created_at ?? "");
      return `- type=${signalType} | value=${signalValue} | at=${createdAt}`;
    })
    .join("\n");
}

function uniqueStrings(items: string[], max: number): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const normalized = item.trim();
    if (!normalized) continue;
    if (seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    deduped.push(normalized);
    if (deduped.length >= max) break;
  }
  return deduped;
}

function parseDomainFromUrl(rawUrl: string): string {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function extractDomainFromSignal(signal: SignalRow): string {
  const meta = signal.metadata;
  if (meta && typeof meta === "object") {
    const tabUrl = String((meta as Json).tabUrl ?? "").trim();
    if (tabUrl) {
      const parsed = parseDomainFromUrl(tabUrl);
      if (parsed) return parsed;
    }
    const url = String((meta as Json).url ?? "").trim();
    if (url) {
      const parsed = parseDomainFromUrl(url);
      if (parsed) return parsed;
    }
    const host = String((meta as Json).domain ?? (meta as Json).hostname ?? "").trim().toLowerCase();
    if (host) return host;
  }
  return parseDomainFromUrl(String(signal.signal_value ?? ""));
}

function extractTitleFromPageContext(pageContext: string): string {
  const text = String(pageContext || "").trim();
  if (!text) return "";
  const titleMatch = text.match(/(?:^|\|)\s*Title:\s*([^|]+)/i);
  if (titleMatch?.[1]) return titleMatch[1].trim().replace(/\s+/g, " ").slice(0, 120);
  return "";
}

function extractTransition(detail: string): string | null {
  const match = String(detail || "").match(/\b(focused|fidgeting|away)\s*->\s*(focused|fidgeting|away)\b/i);
  if (!match) return null;
  return `${match[1].toLowerCase()} -> ${match[2].toLowerCase()}`;
}

function formatIsoMinute(iso: string): string {
  const dt = parseDate(iso);
  if (!dt) return iso;
  return dt.toISOString().slice(0, 16) + "Z";
}

function buildAttentionDigest(
  signals: SignalRow[],
  windowStartIso: string,
  windowEndIso: string,
  transitionTrail: string[],
): AttentionDigestResult {
  const sorted = sortSignalsAsc(signals);
  const count = sorted.length;

  const focusSignals = sorted.filter((s) => String(s.signal_type ?? "").toLowerCase() === "tab_focus");
  const domainSeconds = new Map<string, number>();
  const domainTitle = new Map<string, string>();
  const endMs = parseDate(windowEndIso)?.getTime() ?? Date.now();
  const maxGapMs = MAX_FOCUS_GAP_MINUTES * 60_000;

  for (let i = 0; i < focusSignals.length; i++) {
    const signal = focusSignals[i];
    const domain = extractDomainFromSignal(signal);
    if (!domain) continue;

    const meta = signal.metadata;
    if (meta && typeof meta === "object") {
      const pageContext = String((meta as Json).pageContext ?? "").trim();
      const title = extractTitleFromPageContext(pageContext) || String((meta as Json).title ?? "").trim();
      if (title && !domainTitle.has(domain)) {
        domainTitle.set(domain, title.slice(0, 120));
      }
    }

    const currentMs = parseDate(signal.created_at)?.getTime();
    if (!currentMs) continue;
    let nextMs = endMs;
    if (i < focusSignals.length - 1) {
      const candidate = parseDate(focusSignals[i + 1].created_at)?.getTime();
      if (candidate) nextMs = candidate;
    }
    const clampedGap = Math.max(0, Math.min(nextMs - currentMs, maxGapMs));
    domainSeconds.set(domain, (domainSeconds.get(domain) ?? 0) + clampedGap / 1000);
  }

  const topDomains = [...domainSeconds.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  const focusSummary = topDomains.length
    ? topDomains.map(([domain, seconds]) => {
      const mins = Math.max(1, Math.round(seconds / 60));
      const title = domainTitle.get(domain);
      return title ? `${domain} (${mins}m, "${title}")` : `${domain} (${mins}m)`;
    }).join(", ")
    : "(none)";

  const topics = uniqueStrings(
    sorted
      .filter((s) => String(s.signal_type ?? "").toLowerCase() === "topic_signal")
      .map((s) => String(s.signal_value ?? "").trim().slice(0, 100)),
    3,
  );

  const searches = uniqueStrings(
    sorted
      .filter((s) => {
        const t = String(s.signal_type ?? "").toLowerCase();
        return t === "search_query" || t === "search";
      })
      .map((s) => String(s.signal_value ?? "").trim().slice(0, 100)),
    5,
  );

  const lines = [
    `[${formatIsoMinute(windowStartIso)} - ${formatIsoMinute(windowEndIso)}] | ${count} signals`,
    `Focus: ${focusSummary}`,
  ];
  if (transitionTrail.length > 0) {
    lines.push(`Mode: ${transitionTrail.join(" -> ")}`);
  }
  if (topics.length > 0) {
    lines.push(`Topics: ${topics.join(" | ")}`);
  }
  if (searches.length > 0) {
    lines.push(`Searches: ${searches.join(" | ")}`);
  }

  const digest = lines.join("\n").slice(0, MAX_ATTENTION_DIGEST_CHARS);
  const metadata: Json = {
    top_domains: topDomains.map(([domain]) => domain),
    mode_transitions: Math.max(0, transitionTrail.length - 1),
    topic_signals: topics.length,
    search_queries: searches.length,
  };
  return { digest, metadata };
}

async function fetchModeTransitionsSince(windowStartIso: string): Promise<string[]> {
  const rows = await dbSelect(
    "presence_gate",
    `select=detail,created_at&created_at=gte.${encodeURIComponent(windowStartIso)}&order=created_at.asc&limit=200`,
  );

  const chain: string[] = [];
  let currentMode: string | null = null;

  for (const row of rows) {
    const transition = extractTransition(String(row.detail ?? ""));
    if (!transition) continue;
    const [from, to] = transition.split(" -> ").map((part) => part.trim().toLowerCase());
    if (!from || !to) continue;
    if (currentMode === null) {
      chain.push(from, to);
      currentMode = to;
      continue;
    }
    if (from === currentMode) {
      chain.push(to);
      currentMode = to;
      continue;
    }
    chain.push(from, to);
    currentMode = to;
  }

  const compact: string[] = [];
  for (const mode of chain) {
    if (compact.length === 0 || compact[compact.length - 1] !== mode) {
      compact.push(mode);
    }
  }
  return compact;
}

async function writeAttentionDigest(
  signals: SignalRow[],
  windowStartIso: string,
  windowEndIso: string,
): Promise<void> {
  if (!signals.length) return;
  const transitionTrail = await fetchModeTransitionsSince(windowStartIso);
  const { digest, metadata } = buildAttentionDigest(signals, windowStartIso, windowEndIso, transitionTrail);
  if (!digest.trim()) return;

  const userId = String(signals.find((s) => String(s.user_id ?? "").trim())?.user_id ?? "").trim() || null;
  await dbInsert("attention_digest", {
    user_id: userId,
    digest,
    window_start: windowStartIso,
    window_end: windowEndIso,
    signal_count: signals.length,
    metadata,
  });
}

function formatScoutIntel(run: Json | null): string {
  if (!run) return "(none)";
  const outputEnvelope = run.output_envelope && typeof run.output_envelope === "object"
    ? (run.output_envelope as Json)
    : {};
  const payload = run.payload && typeof run.payload === "object" ? (run.payload as Json) : {};

  const reasoning = String(outputEnvelope.reasoning ?? "").trim();
  const flags = Array.isArray(payload.flags) ? (payload.flags as Json[]) : [];
  const highFlags = flags.filter((f) => String(f.relevance ?? "").toLowerCase() === "high");

  const lines = [`assessment: ${reasoning || "(none)"}`];
  if (highFlags.length) {
    lines.push("high_relevance_flags:");
    for (const flag of highFlags.slice(0, 8)) {
      const title = String(flag.title ?? flag.label ?? flag.name ?? "flag");
      const summary = String(flag.summary ?? flag.detail ?? flag.reason ?? "").slice(0, 220);
      const category = String(flag.category ?? "unknown");
      lines.push(`- ${title} [${category}] ${summary}`);
    }
  }
  return lines.join("\n");
}

function formatPlatformKnowledge(rows: Json[]): string {
  if (!rows.length) return "(none)";
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const platform = String(row.platform ?? "unknown").toLowerCase();
    const content = String(row.content ?? "").trim();
    if (!content) continue;
    if (!grouped.has(platform)) grouped.set(platform, []);
    grouped.get(platform).push(content);
  }
  const sections: string[] = [];
  for (const [platform, facts] of grouped.entries()) {
    sections.push(`${platform.toUpperCase()}:`);
    for (const fact of facts.slice(0, 60)) {
      sections.push(`- ${fact}`);
    }
    sections.push("");
  }
  return sections.join("\n").trim() || "(none)";
}

function formatRecentlySurfaced(rows: Json[]): string {
  if (!rows.length) return "(none)";
  return rows
    .map((r) => `- ${String(r.message ?? "").trim()}`)
    .join("\n");
}

function formatCalibrationLog(rows: Json[]): string | null {
  if (!rows.length) return null;
  const lines = rows.map((r) => {
    const outcome = String(r.outcome ?? "").trim();
    const message = String(r.message ?? "").trim();
    const reasoning = String(r.reasoning ?? "").trim();
    return `- outcome: ${outcome} | message: "${message}" | reasoning: "${reasoning}"`;
  });
  return [
    "[CALIBRATION LOG]",
    "The following are recent breadcrumbs, why I fired them, and how the user graded them.",
    "Use this to calibrate judgment — notice what landed and what didn't.",
    "",
    ...lines,
    "[/CALIBRATION LOG]",
  ].join("\n");
}

/**
 * Fetch a cognitively diverse memory sample using the get_diverse_memory_sample RPC.
 * Returns top 15 by vitality + 5 from sparse cognitive_type x life_domain cells.
 * Falls back to plain vitality-ordered query if RPC fails.
 */
async function fetchDiverseMemories(userId: string = USER_ID): Promise<Json[]> {
  try {
    const url = `${SUPABASE_URL}/rest/v1/rpc/get_diverse_memory_sample`;
    const resp = await fetch(url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        p_user_id: userId,
        top_n: 15,
        diverse_n: 5,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`get_diverse_memory_sample RPC failed (${resp.status}): ${text} — falling back`);
      throw new Error("rpc_failed");
    }

    const rows = await resp.json() as Json[];
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error("rpc_empty");
    }

    return rows.map((r) => ({
      id: String(r.mem_id ?? ""),
      content: String(r.content ?? ""),
      domain: String(r.life_domain ?? "unknown"),
      memory_class: String(r.sample_reason ?? "top_vitality"),
      cognitive_type: String(r.cognitive_type ?? "observation"),
      vitality_score: Number(r.vitality_score ?? 0),
    }));
  } catch (e) {
    console.warn("fetchDiverseMemories falling back to plain vitality sort:", e instanceof Error ? e.message : String(e));
    return dbSelect(
      "memories",
      "select=id,content,domain,memory_class,cognitive_type,vitality_score&order=vitality_score.desc&limit=20",
    );
  }
}

async function fetchTrajectory(userId: string): Promise<string> {
  const rows = await dbSelect(
    "trajectories",
    `select=arcs,tensions,drift&user_id=eq.${encodeURIComponent(userId)}&is_active=eq.true&order=generated_at.desc&limit=1`,
  );
  const t = rows[0] ?? null;
  return formatTrajectory(t);
}

async function fetchPrimeDirective(_userId: string): Promise<string | null> {
  const rows = await dbSelect(
    "presence_state",
    "select=prime_directive&id=eq.1&limit=1",
  );
  const directive = String(rows[0]?.prime_directive ?? "").trim();
  return directive || null;
}

async function fetchRecentSignals(userId: string, minutes: number): Promise<SignalRow[]> {
  const rows = await dbSelect(
    "activity_signal",
    `select=signal_type,signal_value,metadata,created_at,user_id&user_id=eq.${encodeURIComponent(userId)}&created_at=gte.${encodeURIComponent(
      isoMinutesAgo(minutes),
    )}&order=created_at.desc&limit=300`,
  );
  return rows as SignalRow[];
}

async function fetchLastGatekeeperRun(_userId: string): Promise<Json | null> {
  const rows = await dbSelect(
    "gatekeeper_runs",
    "select=run_at,mode_classified,sonnet_decision,notes&order=run_at.desc&limit=1",
  );
  return rows[0] ?? null;
}

async function fetchSessionArc(supabaseUrl: string, supabaseKey: string): Promise<string> {
  try {
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/rpc/get_session_arc`,
      {
        method: "POST",
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ lookback_minutes: 60 }),
      },
    );
    const data = await resp.json().catch(() => ({}));
    return String((data as Json)?.arc_description ?? "").trim();
  } catch (_e) {
    return "";
  }
}

async function callOpus(prompt: string, maxTokens = 200): Promise<string> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const resp = await client.messages.create({
    model: MODEL_OPUS,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });

  const text = resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Opus returned empty response");
  }
  return text;
}

async function assembleIdentityContext(): Promise<{ cachedSystemContext: string; userPromptContext: string; memoryIds: string[] }> {
  const supabaseUrl = SUPABASE_URL;
  const supabaseKey = SUPABASE_SERVICE_ROLE_KEY;

  const [memories, trajectoryRows, activityRows, scoutRuns, platformRows, recentNotifs, gradedNotifs, primeDirective, sessionArc] = await Promise.all([
    fetchDiverseMemories(USER_ID),
    dbSelect("trajectories", "select=arcs,tensions,drift&order=generated_at.desc&limit=1"),
    dbSelect(
      "activity_signal",
      `select=signal_type,signal_value,metadata,created_at&created_at=gte.${encodeURIComponent(
        isoMinutesAgo(24 * 60),
      )}&order=created_at.desc&limit=200`,
    ),
    dbSelect(
      "agent_runs",
      "select=id,created_at,output_envelope,payload&agent=eq.scout&status=eq.completed&order=created_at.desc&limit=1",
    ),
    dbSelect(
      "platform_memories",
      "select=platform,content,last_seen_at&removed_at=is.null&order=last_seen_at.desc&limit=100",
    ),
    dbSelect(
      "presence_notifications",
      `select=message&created_at=gte.${encodeURIComponent(isoMinutesAgo(90))}&order=created_at.desc&limit=5`,
    ),
    dbSelect(
      "presence_notifications",
      "select=message,reasoning,outcome&outcome=not.is.null&reasoning=not.is.null&order=created_at.desc&limit=10",
    ),
    fetchPrimeDirective(USER_ID),
    fetchSessionArc(supabaseUrl, supabaseKey),
  ]);

  const trajectory = trajectoryRows[0] ?? null;
  const scout = scoutRuns[0] ?? null;

  const calibrationLog = formatCalibrationLog(gradedNotifs);
  const cachedSystemParts = [
    "[MEMORIES]",
    formatMemories(memories),
    "[/MEMORIES]",
    "",
    "[PRIME DIRECTIVE]",
    String(primeDirective ?? "None set").trim() || "None set",
    "[/PRIME DIRECTIVE]",
    "",
    "[SESSION ARC]",
    String(sessionArc || "").trim() || "(none)",
    "[/SESSION ARC]",
    "",
    "[TRAJECTORY]",
    formatTrajectory(trajectory),
    "[/TRAJECTORY]",
  ];
  if (calibrationLog) {
    cachedSystemParts.push("", calibrationLog);
  }
  const cachedSystemContext = cachedSystemParts.join("\n");

  const userPromptContext = [
    "[RECENT ACTIVITY]",
    formatActivity(activityRows),
    "[/RECENT ACTIVITY]",
    "",
    "[PLATFORM KNOWLEDGE]",
    formatPlatformKnowledge(platformRows),
    "[/PLATFORM KNOWLEDGE]",
    "",
    "[RECENT INTELLIGENCE]",
    formatScoutIntel(scout),
    "[/RECENT INTELLIGENCE]",
    "",
    "[RECENTLY SURFACED]",
    formatRecentlySurfaced(recentNotifs),
    "[/RECENTLY SURFACED]",
  ].join("\n");

  const memoryIds = memories
    .map((m) => String(m.id ?? "").trim())
    .filter((id) => id.length > 0);

  return { cachedSystemContext, userPromptContext, memoryIds };
}

async function synthesizePresenceMessage(cachedSystemContext: string, promptContext: string): Promise<OpusSynthesisResult> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: MODEL_OPUS,
    max_tokens: 350,
    system: [
      { type: "text", text: SYSTEM_INSTRUCTION },
      {
        type: "text",
        text: cachedSystemContext,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: promptContext }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Anthropic returned empty response.");
  }

  const raw = text.trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let message = "";
  let reasoning: string | null = null;

  try {
    const parsed = JSON.parse(raw) as Json;
    message = String(parsed.message ?? "").trim();
    reasoning = parsed.reasoning === null || parsed.reasoning === undefined
      ? null
      : String(parsed.reasoning).trim() || null;
  } catch (e) {
    console.error("Opus JSON parse failed, falling back to raw text:", e);
    message = raw;
    reasoning = null;
  }

  if (!message) {
    throw new Error("Opus response missing non-empty message.");
  }

  return { message, reasoning };
}

async function writePresenceNotification(message: string, reasoning: string | null, contextMemoryIds: string[]): Promise<void> {
  await dbInsert("presence_notifications", {
    message,
    reasoning,
    trigger_type: "state_change",
    read: false,
    scored: false,
    context_memories: contextMemoryIds,
  });
}

async function admitSynthesisMemory(content: string): Promise<void> {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/admit-memory`, {
    method: "POST",
    headers: {
      ...jsonHeaders(),
    },
    body: JSON.stringify({
      content,
      source: "opus_synthesis",
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`admit-memory failed (${resp.status}): ${text}`);
  }
}

async function askGateJudgment(
  oldMode: Mode,
  newMode: Mode,
  activityRows: SignalRow[],
  triggerType: "transition" | "steady_state" = "transition",
): Promise<{ fire: boolean; reason: string }> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const prompt = [
    "You are a presence system hunting for something worth saying.",
    "",
    "Your job is to find the most interesting, useful, or timely thing you could surface right now — then ask: does it clear the bar for this moment? If yes, fire. If no, stay silent. But you are always searching first.",
    "",
    triggerType === "transition"
      ? `A mode transition just occurred: ${oldMode} -> ${newMode}`
      : `User has been in ${newMode.toUpperCase()} mode for an extended period. Evaluate the accumulated signals.`,
    `Current cognitive state: ${newMode.toUpperCase()}`,
    "",
    "The current mode sets the interrupt bar — not whether to speak, but how high the bar is:",
    "- FOCUSED: HIGHEST bar. Only fire if the observation is directly actionable in the next 60 seconds. Not synthesis, not pattern recognition — something usable right now. If it's interesting but not immediately actionable, stay silent. Protect the work.",
    "- FIDGETING: LOW bar. User is between things and receptive by definition. Do not wait for a transition out of fidgeting — if the signal is coherent and interesting, fire now. Exploratory, connective, speculative output all valid.",
    "- AWAY/IDLE: LOWEST bar. Natural re-entry window. Surface anything contextually relevant — reorientation, synthesis, what accumulated while they were gone. Almost anything clears this bar.",
    "",
    "If this insight has already fired and nothing irreversible is in flight — do not repeat it. One mention was enough. Let it go.",
    "If an irreversible action IS in flight (compose window open, audience-facing output being finalized, overlapping live workstreams) — fire regardless of repetition.",
    "",
    'Answer ONLY with JSON: {"fire": true/false, "reason": "one sentence why"}',
    "",
    "[ACTIVITY]",
    JSON.stringify(activityRows, null, 2),
  ].join("\n");

  const resp = await client.messages.create({
    model: MODEL_OPUS,
    max_tokens: 180,
    messages: [{ role: "user", content: prompt }],
  });

  const text = resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (!text) {
    return { fire: false, reason: "Judge returned empty output" };
  }

  try {
    const parsed = JSON.parse(text) as Json;
    return {
      fire: Boolean(parsed.fire),
      reason: String(parsed.reason ?? "No reason provided"),
    };
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as Json;
        return {
          fire: Boolean(parsed.fire),
          reason: String(parsed.reason ?? "No reason provided"),
        };
      } catch {
        // fallthrough
      }
    }
    return { fire: false, reason: `Unparseable judge output: ${text.slice(0, 160)}` };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return response({ error: "Method not allowed" }, 405);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return response(
      {
        error: "Missing required env vars (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).",
      },
      500,
    );
  }

  try {
    const payload = (await req.json().catch(() => ({}))) as Json;
    const action = String(payload.action ?? "").trim().toLowerCase();

    if (action === "set_directive") {
      const rawDirective = payload.directive;
      const directive = (rawDirective === null || rawDirective === undefined)
        ? null
        : String(rawDirective).trim();
      const nowIso = new Date().toISOString();

      await dbUpsert("presence_state", {
        id: 1,
        prime_directive: directive && directive.length > 0 ? directive : null,
        directive_set_at: directive && directive.length > 0 ? nowIso : null,
        updated_at: nowIso,
      });

      return response({
        status: "ok",
        action: "set_directive",
        prime_directive: directive && directive.length > 0 ? directive : null,
        directive_set_at: directive && directive.length > 0 ? nowIso : null,
      });
    }

    if (!ANTHROPIC_API_KEY) {
      return response(
        {
          error: "Missing required env var ANTHROPIC_API_KEY for synthesis path.",
        },
        500,
      );
    }

    const trigger = String(payload.trigger ?? "sweep").trim().toLowerCase();
    const userId = String(payload.user_id ?? USER_ID).trim() || USER_ID;

    if (trigger === "status_request") {
      const [state, memories, trajectory, primeDirective, recentSignals, lastRun] = await Promise.all([
        readPresenceState(),
        fetchDiverseMemories(userId),
        fetchTrajectory(userId),
        fetchPrimeDirective(userId),
        fetchRecentSignals(userId, 30),
        fetchLastGatekeeperRun(userId),
      ]);

      const modeSinceMinutes = state.mode_since ? Math.max(0, Math.round(minutesSince(state.mode_since))) : null;
      const modeDuration = modeSinceMinutes === null
        ? "unknown"
        : modeSinceMinutes < 1
        ? "under a minute"
        : modeSinceMinutes === 1
        ? "about 1 minute"
        : `about ${modeSinceMinutes} minutes`;

      const statusPrompt = `You are Presence. The user is asking what you're currently observing.

[CURRENT MODE]
${state.current_mode} for ${modeDuration}

[PRIME DIRECTIVE]
${primeDirective || "None set"}

[TRAJECTORY]
${trajectory}

[TOP MEMORIES]
${memories.map((m) => String(m.content ?? "")).filter(Boolean).join("\n") || "(none)"}

[RECENT SIGNALS — last 30 min]
${recentSignals.map((s) => `${String(s.signal_type ?? "unknown")}: ${String(s.signal_value ?? "").slice(0, 120)}`).join("\n") || "(none)"}

[LAST SWEEP]
Mode: ${String(lastRun?.mode_classified ?? "unknown")}, Decision: ${String(lastRun?.sonnet_decision ?? "unknown")}, ${String(lastRun?.notes ?? "")}

Write 2-4 sentences in first person. Tell the user:
- What mode they've been in and for roughly how long
- What 1-2 threads or patterns you've been tracking across their recent signals and memories
- Honestly why you haven't spoken (nothing cleared the bar, same context, waiting for a break, etc.)

Be specific. Name actual content from the signals. Do not be vague or generic.
Do not start with "I". Do not use bullet points. Plain prose only.`;

      const opusResponse = await callOpus(statusPrompt, 200);
      return response({ status_summary: opusResponse });
    }

    const eventCreatedAt = String(
      payload.created_at ??
        (payload.record && typeof payload.record === "object" ? (payload.record as Json).created_at : "") ??
        "",
    ) || new Date().toISOString();

    const signalsRaw = await dbSelect(
      "activity_signal",
      `select=id,user_id,signal_type,signal_value,metadata,created_at&created_at=gte.${encodeURIComponent(
        isoMinutesAgo(MODE_WINDOW_MINUTES),
      )}&order=created_at.asc&limit=500`,
    );
    const recentSignals = signalsRaw as SignalRow[];
    const signalCount = recentSignals.length;

    // Mode classification for logging/context only — not a gate
    const modeResult = classifyMode(recentSignals);

    const state = await readPresenceState();

    // Gate 1: no signals → nothing to evaluate
    if (signalCount === 0) {
      await logGatekeeperRun(0, modeResult.mode, "skip_no_signals", false, "No signals in window");
      return response({ status: "suppressed", reason: "no_signals" });
    }

    // Gate 2: debounce — too soon since last state update
    const sinceStateUpdate = minutesSince(state.updated_at) * 60;
    if (sinceStateUpdate < 5) {
      await logGatekeeperRun(signalCount, modeResult.mode, "skip_debounced", false, `State updated ${sinceStateUpdate.toFixed(0)}s ago`);
      return response({ status: "suppressed", reason: "debounced" });
    }

    // Gate 3: rate limit — minimum gap between fires
    const sinceLastFire = minutesSince(state.last_fire_at);
    if (sinceLastFire < MIN_FIRE_GAP_MINUTES) {
      await logGatekeeperRun(signalCount, modeResult.mode, "skip_rate_limited", false, `${sinceLastFire.toFixed(1)}m < ${MIN_FIRE_GAP_MINUTES}m gap`);
      return response({ status: "suppressed", reason: "rate_limited" });
    }

    // Gate 4 (Layer 0): Haiku novelty check — has context meaningfully changed?
    const novelty = await checkNovelty(recentSignals);
    if (!novelty.novel) {
      await logGatekeeperRun(signalCount, modeResult.mode, "skip_not_novel", false, novelty.reason);
      return response({ status: "suppressed", reason: "not_novel" });
    }

    // Update mode in presence_state for downstream consumers
    if (state.current_mode !== modeResult.mode) {
      await updatePresenceState({
        current_mode: modeResult.mode,
        mode_since: new Date().toISOString(),
      });
    }

    const transitionLabel = `${state.current_mode} -> ${modeResult.mode}`;

    const activitySince = state.last_fire_at
      ? String(state.last_fire_at)
      : isoMinutesAgo(FALLBACK_ACTIVITY_HOURS * 60);

    const judgmentRowsRaw = await dbSelect(
      "activity_signal",
      `select=id,user_id,signal_type,signal_value,metadata,created_at&created_at=gte.${encodeURIComponent(activitySince)}&order=created_at.asc&limit=1000`,
    );
    const judgmentRows = judgmentRowsRaw as SignalRow[];

    const judgment = await askGateJudgment(
      state.current_mode,
      modeResult.mode,
      judgmentRows,
      state.current_mode === modeResult.mode ? "steady_state" : "transition",
    );
    if (!judgment.fire) {
      await logGate(
        "suppressed",
        signalCount,
        `Judge declined for ${transitionLabel}: ${judgment.reason}`,
        { burstDetected: modeResult.mode === "fidgeting", lastSignalAt: eventCreatedAt, lastFireAt: state.last_fire_at },
      );
      await logGatekeeperRun(signalCount, modeResult.mode, "sonnet_declined", false, judgment.reason);
      return response({
        status: "suppressed",
        stage: 3,
        reason: judgment.reason,
        transition: transitionLabel,
      });
    }

    writeAttentionDigest(judgmentRows, activitySince, eventCreatedAt).catch((error) => {
      console.warn("Presence gatekeeper: attention digest write failed", error instanceof Error ? error.message : String(error));
    });

    const { cachedSystemContext, userPromptContext, memoryIds } = await assembleIdentityContext();
    const synthesisPrompt = [
      userPromptContext,
      "",
      "[TRIGGER]",
      `Mode transition: ${transitionLabel}`,
      `Classifier rationale: ${modeResult.reason}`,
      `Gatekeeper rationale: ${judgment.reason}`,
      "[/TRIGGER]",
      "",
      "You MUST respond with ONLY a valid JSON object. No preamble, no explanation, no markdown fences. The response must begin with { and end with }.",
      "",
      "Required format:",
      "{",
      '  "message": "one sentence or question, the breadcrumb",',
      '  "reasoning": "2-3 sentences explaining what signals triggered this and why it cleared the bar"',
      "}",
      "",
      "IMPORTANT: Do not surface a connection already covered in [RECENTLY SURFACED]. If the most salient thing in context has already been said, find the next most interesting connection — or return SILENCE.",
    ].join("\n");

    const opus = await synthesizePresenceMessage(cachedSystemContext, synthesisPrompt);
    const message = opus.message;
    const reasoning = opus.reasoning;
    const nowIso = new Date().toISOString();

    let wroteNotification = false;
    if (message.trim().toUpperCase() !== "SILENCE") {
      await writePresenceNotification(message, reasoning, memoryIds);
      wroteNotification = true;
    }

    await updatePresenceState({
      last_fire_at: nowIso,
      last_fire_reason: `${transitionLabel} | ${judgment.reason}`,
    });

    await logGate(
      "fired",
      signalCount,
      `Fired on ${transitionLabel}; judgement=${judgment.reason}; wrote_notification=${wroteNotification}`,
      { burstDetected: modeResult.mode === "fidgeting", lastSignalAt: eventCreatedAt, lastFireAt: nowIso },
    );

    await logGatekeeperRun(signalCount, modeResult.mode, "sonnet_approved", wroteNotification, `${judgment.reason}; opus=${wroteNotification ? "fired" : "SILENCE"}`);

    return response({
      status: "fired",
      stage: 4,
      transition: transitionLabel,
      wrote_notification: wroteNotification,
      response_preview: message.slice(0, 200),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    try {
      await logGate("suppressed", 0, `Gatekeeper error: ${detail}`);
      await logGatekeeperRun(0, "unknown", "error", false, detail);
    } catch {
      // ignore secondary failures
    }
    return response({ error: detail }, 500);
  }
});
