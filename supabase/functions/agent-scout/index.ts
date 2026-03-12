import "jsr:@supabase/functions-js/edge-runtime.d.ts";

var SUPABASE_URL = Deno.env.get("SUPABASE_URL");
var SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
var ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
var HEARTH_USER_ID = "95aa73e2-ac1a-4ac6-bfae-15a946b11131";

// Module-level dynamic keywords — set after research focus generation
var activeKeywords: string[] = [];

var CORE_KEYWORDS = [
  "hearth", "personal ai", "proactive ai", "ambient ai", "identity",
  "alignment", "sycophancy", "context engineering", "mcp",
  "specification engineering", "limitless", "screenpipe",
  "personal intelligence", "gemini personal"
];

function restHeaders() {
  return {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON_KEY || "",
    "Authorization": "Bearer " + (SUPABASE_ANON_KEY || ""),
    "Prefer": "return=representation"
  };
}

async function dbInsert(table: string, data: any): Promise<any> {
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + table, {
    method: "POST", headers: restHeaders(), body: JSON.stringify(data)
  });
  if (!res.ok) {
    var err = await res.text();
    throw new Error("DB insert failed (" + res.status + "): " + err);
  }
  var result = await res.json();
  return result[0] || result;
}

async function dbSelect(table: string, query: string): Promise<any[]> {
  var h: any = restHeaders();
  delete h["Prefer"];
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?" + query, { headers: h });
  if (!res.ok) return [];
  return await res.json();
}

async function rpcBeat(name: string, meta: any): Promise<void> {
  try {
    await fetch(SUPABASE_URL + "/rest/v1/rpc/beat", {
      method: "POST",
      headers: restHeaders(),
      body: JSON.stringify({ p_name: name, p_meta: meta || {} })
    });
  } catch (e) { console.warn("Heartbeat failed:", e); }
}

function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  return fetch(url, Object.assign({}, options, { signal: controller.signal })).finally(function() { clearTimeout(timer); });
}

var FALLBACK_KEYWORDS = [
  "ai agent", "llm", "anthropic", "openai", "claude", "gpt", "gemini",
  "ai assistant", "ai safety", "inference",
  "multi-agent", "agent framework", "tool use", "function calling",
  "personalization", "ai memory", "memory", "context window", "persistent memory",
  "ai companion", "ai wearable", "lifelogging",
  "chatgpt pulse", "apple intelligence", "siri", "rabbit r1",
  "tab ai", "friend ai", "omi ai", "manus",
  "model context protocol", "rag", "embedding",
  "chrome extension ai", "browser agent",
  "prompt engineering", "fine-tuning",
  "preference learning", "user modeling", "intent engineering"
];

function matchesKeywords(text: string): boolean {
  var lower = text.toLowerCase();
  var allKeywords = CORE_KEYWORDS.concat(activeKeywords);
  for (var i = 0; i < allKeywords.length; i++) {
    if (lower.includes(allKeywords[i])) return true;
  }
  return false;
}

// v18: Sonnet generates the research question (was Opus in v16/v17 — cost fix)
async function generateResearchFocus(hearthContext: string): Promise<{question: string, keywords: string[], reasoning: string}> {
  var fallback = {
    question: "What competitive moves and research are happening in the personal AI and identity-aware agent space?",
    keywords: FALLBACK_KEYWORDS,
    reasoning: "Fallback to default competitive scan"
  };

  if (!ANTHROPIC_API_KEY) return fallback;

  try {
    var activityResults = await Promise.allSettled([
      dbSelect("activity_signal", "select=signal_type,signal_value,metadata,created_at&order=created_at.desc&limit=50"),
      dbSelect("presence_notifications", "select=message,trigger_type,created_at&order=created_at.desc&limit=5"),
      dbSelect("attention_digest", "select=digest,window_start,window_end,created_at&order=created_at.desc&limit=20&created_at=gte." + new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()),
      dbSelect("presence_gate", "select=detail,status,created_at&status=eq.fired&order=created_at.desc&limit=5"),
      dbSelect("agent_runs", "select=payload,created_at&agent=eq.scout&status=eq.completed&order=created_at.desc&limit=1")
    ]);

    var activity = activityResults[0].status === "fulfilled" ? activityResults[0].value : [];
    var notifications = activityResults[1].status === "fulfilled" ? activityResults[1].value : [];
    var digests = activityResults[2].status === "fulfilled" ? activityResults[2].value : [];
    var recentFires = activityResults[3].status === "fulfilled" ? activityResults[3].value : [];
    var lastScoutRun = activityResults[4].status === "fulfilled" ? activityResults[4].value : [];

    var lastQuestion = "";
    if (lastScoutRun.length > 0 && lastScoutRun[0].payload && lastScoutRun[0].payload.research_focus) {
      lastQuestion = lastScoutRun[0].payload.research_focus.question || "";
    }

    var userContent = hearthContext +
      "\n[ATTENTION DIGESTS — LAST 48 HOURS]\nThese are compressed summaries of what the user has been focused on:\n" + 
      digests.map(function(d: any) { return d.digest; }).join("\n\n") +
      "\n\n[RECENT ACTIVITY SIGNALS — LAST 50]\n" + JSON.stringify(activity, null, 2) +
      "\n\n[RECENT PRESENCE NOTIFICATIONS — What the system surfaced recently]\n" + JSON.stringify(notifications, null, 2) +
      "\n\n[RECENT FIRE DECISIONS — What triggered notifications]\n" + JSON.stringify(recentFires, null, 2) +
      (lastQuestion ? "\n\n[LAST SCOUT QUESTION — DO NOT REPEAT THIS]\n" + lastQuestion : "");

    // v18: Sonnet generates the question — same quality for this task at ~10x lower cost than Opus
    var res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        system: "You are the research director for a personal AI system called Presence. You see what this person has been doing, thinking about, and working on over the last 48 hours.\n\nYour job: generate ONE research question for the next intelligence scan. The question must be:\n\n1. INSPIRED BY WHAT'S ACTUALLY HAPPENING — not generic industry scanning. Look at their attention digests, their browsing, their searches. What are they stuck on? What thread are they pulling? What did they just discover that has unexplored implications?\n\n2. CONNECTIVE — bridge something in their current work to something in the outside world they haven't encountered. The best questions make the person say 'I hadn't thought to look there.'\n\n3. DIFFERENT FROM LAST TIME — you'll see the previous scout question. Go somewhere new. If last time was about competitors, this time look at adjacent fields. If last time was research, this time look at market signals.\n\n4. SPECIFIC — 'What's new in personal AI' is useless. 'Are any browser extension frameworks solving the content script injection timing problem that causes signal loss during SPA navigation?' is useful.\n\nAlso generate 5-8 search keywords that would find relevant results across Hacker News, GitHub, arxiv, and Reddit. Keywords should be specific enough to filter noise but broad enough to catch adjacent signals.\n\nRespond ONLY with valid JSON, no markdown backticks:\n{\"question\": \"...\", \"keywords\": [\"...\"], \"reasoning\": \"one sentence on why this matters right now based on what you see in their recent activity\"}",
        messages: [{ role: "user", content: userContent }]
      })
    }, 60000);

    var data = await res.json();
    var text = data.content && data.content[0] ? data.content[0].text : "";
    var parsed = JSON.parse(text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim());

    if (parsed.question && parsed.keywords && Array.isArray(parsed.keywords)) {
      return {
        question: parsed.question,
        keywords: parsed.keywords.map(function(k: string) { return k.toLowerCase(); }),
        reasoning: parsed.reasoning || "No reasoning provided"
      };
    }
    return fallback;
  } catch (e) {
    console.error("Research focus generation failed:", e);
    return fallback;
  }
}

async function fetchHNTop(): Promise<any[]> {
  try {
    var topRes = await fetchWithTimeout("https://hacker-news.firebaseio.com/v0/topstories.json");
    var topIds: number[] = await topRes.json();
    var stories = await Promise.all(
      topIds.slice(0, 60).map(async function(id) {
        try {
          var res = await fetchWithTimeout("https://hacker-news.firebaseio.com/v0/item/" + id + ".json", {}, 5000);
          return await res.json();
        } catch (e) { return null; }
      })
    );
    return stories.filter(function(s) {
      return s && s.title && matchesKeywords(s.title + " " + (s.url || ""));
    }).map(function(s) {
      return { source: "hn_top", title: s.title, url: s.url || ("https://news.ycombinator.com/item?id=" + s.id), score: s.score, comments: s.descendants || 0, hn_id: s.id };
    });
  } catch (e) { console.error("HN top error:", e); return []; }
}

async function fetchHNNew(): Promise<any[]> {
  try {
    var newRes = await fetchWithTimeout("https://hacker-news.firebaseio.com/v0/newstories.json");
    var newIds: number[] = await newRes.json();
    var stories = await Promise.all(
      newIds.slice(0, 100).map(async function(id) {
        try {
          var res = await fetchWithTimeout("https://hacker-news.firebaseio.com/v0/item/" + id + ".json", {}, 5000);
          return await res.json();
        } catch (e) { return null; }
      })
    );
    return stories.filter(function(s) {
      return s && s.title && matchesKeywords(s.title + " " + (s.url || ""));
    }).map(function(s) {
      return { source: "hn_new", title: s.title, url: s.url || ("https://news.ycombinator.com/item?id=" + s.id), score: s.score || 0, comments: s.descendants || 0, hn_id: s.id };
    });
  } catch (e) { console.error("HN new error:", e); return []; }
}

async function fetchGitHub(): Promise<any[]> {
  try {
    var since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    var dynamicQueries = activeKeywords.slice(0, 4).map(function(kw) {
      return kw.replace(/\s+/g, "+") + "+created:>" + since;
    });
    if (dynamicQueries.length === 0) {
      dynamicQueries = [
        "personal+ai+memory+created:>" + since,
        "ai+identity+context+agent+created:>" + since,
        "proactive+ai+assistant+created:>" + since,
        "mcp+server+created:>" + since
      ];
    }
    var allRepos: any[] = [];
    for (var q of dynamicQueries) {
      try {
        var res = await fetchWithTimeout(
          "https://api.github.com/search/repositories?q=" + q + "&sort=stars&order=desc&per_page=10",
          { headers: { "Accept": "application/vnd.github.v3+json", "User-Agent": "Hearth-Scout" } }
        );
        var data = await res.json();
        if (data.items) {
          for (var r of data.items) {
            allRepos.push({ source: "github", title: r.full_name, url: r.html_url, description: r.description || "", stars: r.stargazers_count, language: r.language, created_at: r.created_at });
          }
        }
      } catch (e) { }
    }
    var seen = new Set();
    return allRepos.filter(function(r) { if (seen.has(r.url)) return false; seen.add(r.url); return true; });
  } catch (e) { console.error("GitHub error:", e); return []; }
}

async function fetchArxiv(): Promise<any[]> {
  try {
    var dynamicQueries = activeKeywords.slice(0, 3).map(function(kw) {
      return kw.replace(/\s+/g, "+");
    });
    if (dynamicQueries.length === 0) {
      dynamicQueries = [
        "proactive+ai+personalization",
        "llm+user+identity+modeling",
        "agent+alignment+preference+learning"
      ];
    }
    var allPapers: any[] = [];
    for (var q of dynamicQueries) {
      try {
        var res = await fetchWithTimeout(
          "https://export.arxiv.org/api/query?search_query=all:" + q + "&sortBy=submittedDate&sortOrder=descending&max_results=10", {}, 15000
        );
        var xml = await res.text();
        var entries = xml.split("<entry>").slice(1);
        for (var entry of entries) {
          var titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
          var title = titleMatch ? titleMatch[1].trim().replace(/\n/g, " ") : "";
          var summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
          var summary = summaryMatch ? summaryMatch[1].trim().replace(/\n/g, " ").slice(0, 300) : "";
          var idMatch = entry.match(/<id>(.*?)<\/id>/);
          var link = idMatch ? idMatch[1] : "";
          var pubMatch = entry.match(/<published>(.*?)<\/published>/);
          var published = pubMatch ? pubMatch[1] : "";
          if (new Date(published) < new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)) continue;
          allPapers.push({ source: "arxiv", title: title, url: link, summary: summary, published: published });
        }
      } catch (e) { console.error("arxiv query failed:", e); }
    }
    var seen = new Set();
    return allPapers.filter(function(p) { if (seen.has(p.url)) return false; seen.add(p.url); return true; });
  } catch (e) { console.error("arxiv error:", e); return []; }
}

async function fetchReddit(): Promise<any[]> {
  try {
    var subreddits = ["LocalLLaMA", "MachineLearning", "ChatGPT", "ClaudeAI", "singularity"];
    var allPosts: any[] = [];
    for (var sub of subreddits) {
      try {
        var res = await fetchWithTimeout("https://www.reddit.com/r/" + sub + "/hot.json?limit=25", { headers: { "User-Agent": "Hearth-Scout/1.0" } });
        var data = await res.json();
        if (data && data.data && data.data.children) {
          for (var child of data.data.children) {
            var post = child.data;
            if (!post || post.stickied) continue;
            if (!matchesKeywords(post.title + " " + (post.selftext || ""))) continue;
            allPosts.push({ source: "reddit", subreddit: sub, title: post.title, url: "https://reddit.com" + post.permalink, score: post.score, comments: post.num_comments, selftext_preview: (post.selftext || "").slice(0, 200) });
          }
        }
      } catch (e) { console.error("Reddit r/" + sub + " failed:", e); }
    }
    return allPosts;
  } catch (e) { console.error("Reddit error:", e); return []; }
}

async function getHearthContext(): Promise<string> {
  var results = await Promise.all([
    dbSelect("opspecs", "user_id=eq." + HEARTH_USER_ID + "&limit=1"),
    dbSelect("memories", "heat=gte.0.6&order=heat.desc&limit=20&select=content,domain,type,heat"),
    dbSelect("trajectories", "user_id=eq." + HEARTH_USER_ID + "&is_active=eq.true&order=generated_at.desc&limit=1&select=arcs,tensions,drift"),
    dbSelect("attention_digest", "select=digest,window_start,window_end,created_at&order=created_at.desc&limit=10&created_at=gte." + new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
  ]);
  var opspec = results[0] && results[0][0];
  var memories = results[1] || [];
  var trajectory = results[2] && results[2][0];
  var digests = results[3] || [];
  var context = "[HEARTH CONTEXT FOR SCOUT AGENT]\nYou are the Scout agent for Presence, a personal AI operating system.\nPresence is an alignment layer that makes other AI agents work better for specific individuals through identity modeling, behavioral signals, and proactive presence.\nCore thesis: personalization IS alignment — AI safety requires knowing which specific human is being served.\n\n";
  if (opspec) context += "[VALUES]\nCognitive Architecture: " + opspec.cognitive_architecture + "\nIdentity: " + opspec.identity + "\nCommunication: " + opspec.communication + "\nExecution: " + opspec.execution + "\nBalance Protocol: " + opspec.balance_protocol + (opspec.constraints ? "\nConstraints: " + opspec.constraints : "") + "\n\n";
  if (memories.length > 0) context += "[KEY MEMORIES]\n" + memories.map(function(m: any) { return "- [" + m.domain + "/" + m.type + "] " + m.content; }).join("\n") + "\n\n";
  if (trajectory) context += "[TRAJECTORY]\nARCS: " + trajectory.arcs + "\nTENSIONS: " + trajectory.tensions + "\nDRIFT: " + trajectory.drift + "\n\n";
  if (digests.length > 0) context += "[RECENT ATTENTION PATTERNS]\n" + digests.map(function(d: any) { return d.digest; }).join("\n\n") + "\n\n";
  return context;
}

async function analyzeWithLLM(hearthContext: string, researchFocus: {question: string, keywords: string[], reasoning: string}, hnTop: any[], hnNew: any[], gh: any[], arxiv: any[], reddit: any[]): Promise<any> {
  if (!ANTHROPIC_API_KEY) return { flags: [], reasoning: "No API key" };
  var prompt = hearthContext +
    "\n[SCOUT TASK — DYNAMIC RESEARCH SCAN]\n" +
    "RESEARCH QUESTION: " + researchFocus.question + "\n" +
    "WHY THIS MATTERS: " + researchFocus.reasoning + "\n" +
    "SEARCH KEYWORDS USED: " + researchFocus.keywords.join(", ") + "\n" +
    "\nYou are scanning multiple sources to answer this research question for the Presence builder.\n" +
    "\nPresence is a personal AI operating system — an alignment layer that makes other AI agents work better for specific individuals through identity modeling, behavioral signals, and proactive presence.\n" +
    "\nKNOWN COMPETITORS (always flag news about these):\n" +
    "- ChatGPT Pulse (OpenAI proactive daily briefs)\n" +
    "- Google Gemini Personal Intelligence\n" +
    "- Apple Intelligence / Siri 2.0\n" +
    "- Meta Personal AI / Manus Agents\n" +
    "- Limitless (pendant + lifelogging)\n" +
    "- Screenpipe (open source screen/audio capture)\n" +
    "- Glean (enterprise proactive AI)\n" +
    "- Tab AI, Friend AI, Omi AI\n" +
    "- Trace, t54 Labs, Cofia (YC W2026 cohort)\n" +
    "\nFLAG IF:\n" +
    "- Directly answers, complicates, or reframes the research question above\n" +
    "- Any competitor from the known list ships features or raises funding\n" +
    "- Research that validates or challenges the Presence thesis (personalization IS alignment)\n" +
    "- New entrants in personal AI, identity-aware agents, or context engineering\n" +
    "- Anything that would make the Presence builder say 'huh, I hadn't connected those'\n" +
    "\nIGNORE:\n" +
    "- Generic AI news unrelated to the research question or competitors\n" +
    "- Enterprise-only tools with no personal AI angle\n" +
    "- AI coding tools unless they involve personal context injection\n" +
    "\nFor each flagged item, determine:\n" +
    "1. Relevance (high/medium/low)\n" +
    "2. Category: competitor_move, new_entrant, research, thesis_validation, threat, opportunity, question_answer\n" +
    "3. Summary: one sentence connecting to the research question (be specific)\n" +
    "4. Confidence (0.0-1.0)\n" +
    "\nSources:\n" +
    "\nHN Top:\n" + JSON.stringify(hnTop, null, 2) +
    "\n\nHN New:\n" + JSON.stringify(hnNew, null, 2) +
    "\n\nGitHub:\n" + JSON.stringify(gh, null, 2) +
    "\n\narxiv:\n" + JSON.stringify(arxiv, null, 2) +
    "\n\nReddit:\n" + JSON.stringify(reddit, null, 2) +
    '\n\nRespond ONLY with valid JSON:\n{"flags":[{"source":"...","title":"...","url":"...","relevance":"high|medium|low","category":"competitor_move|new_entrant|research|thesis_validation|threat|opportunity|question_answer","summary":"...","confidence":0.0-1.0}],"overall_assessment":"2-3 sentences on what this scan means for the research question and Presence competitive position","uncertainty_flags":["..."]}';

  var res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 3000, messages: [{ role: "user", content: prompt }] })
  }, 60000);
  var data = await res.json();
  var text = data.content && data.content[0] ? data.content[0].text : "";
  try { return JSON.parse(text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim()); }
  catch (e) { return { flags: [], reasoning: "Parse failed", raw_response: text }; }
}

Deno.serve(async function(req: Request) {
  var startTime = Date.now();
  try {
    var hearthCtx = await getHearthContext();

    // v18: Sonnet generates research question (was Opus — cost fix)
    var researchFocus = await generateResearchFocus(hearthCtx);
    console.log("[v18] Sonnet research question: " + researchFocus.question);
    console.log("[v18] Keywords: " + researchFocus.keywords.join(", "));
    console.log("[v18] Reasoning: " + researchFocus.reasoning);

    activeKeywords = researchFocus.keywords;

    var results = await Promise.allSettled([
      fetchHNTop(), fetchHNNew(), fetchGitHub(), fetchArxiv(), fetchReddit()
    ]);

    var hnTop = results[0].status === "fulfilled" ? results[0].value : [];
    var hnNew = results[1].status === "fulfilled" ? results[1].value : [];
    var gh = results[2].status === "fulfilled" ? results[2].value : [];
    var arxiv = results[3].status === "fulfilled" ? results[3].value : [];
    var reddit = results[4].status === "fulfilled" ? results[4].value : [];

    var sourceNames = ["hn_top","hn_new","github","arxiv","reddit"];
    var failures: string[] = [];
    for (var i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") failures.push(sourceNames[i]);
    }

    console.log("Scan: " + hnTop.length + " HN top, " + hnNew.length + " HN new, " + gh.length + " GH, " + arxiv.length + " arxiv, " + reddit.length + " reddit");

    var analysis = await analyzeWithLLM(hearthCtx, researchFocus, hnTop, hnNew, gh, arxiv, reddit);

    var flagList = analysis.flags || [];
    var highCount = 0;
    var confSum = 0;
    for (var j = 0; j < flagList.length; j++) {
      if (flagList[j].relevance === "high") highCount++;
      confSum += (flagList[j].confidence || 0.5);
    }

    var outputEnvelope = {
      source_agent: "scout", target_agent: "strategist",
      timestamp: new Date().toISOString(),
      confidence: flagList.length > 0 ? confSum / flagList.length : 0,
      register: "analytical", reasoning_visible: true,
      reasoning: analysis.overall_assessment || "Scan completed",
      uncertainty_flags: analysis.uncertainty_flags || []
    };

    var scanStats = {
      sources_checked: ["hn_top", "hn_new", "github", "arxiv", "reddit"],
      sources_failed: failures,
      hn_top_scanned: hnTop.length, hn_new_scanned: hnNew.length,
      github_repos_scanned: gh.length, arxiv_papers_scanned: arxiv.length,
      reddit_posts_scanned: reddit.length,
      items_flagged: flagList.length, high_relevance: highCount
    };

    var elapsed = Date.now() - startTime;

    var run = await dbInsert("agent_runs", {
      agent: "scout",
      status: "completed",
      triggered_by: "manual",
      model: "claude-sonnet-4-6+claude-haiku-4-5-20251001",
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
      output_envelope: outputEnvelope,
      payload: {
        research_focus: {
          question: researchFocus.question,
          keywords: researchFocus.keywords,
          reasoning: researchFocus.reasoning
        },
        flags: flagList,
        scan_stats: scanStats
      }
    });

    if (flagList.length > 0 || analysis.overall_assessment) {
      try {
        await dbInsert("activity_signal", {
          signal_type: "scout_intel",
          signal_value: (researchFocus.question || "competitive scan").substring(0, 200),
          metadata: {
            run_id: run.id || null,
            finding_count: flagList.length,
            high_relevance: highCount,
            research_keywords: researchFocus.keywords.slice(0, 8),
            assessment_preview: (analysis.overall_assessment || "").substring(0, 300),
            source: "agent-scout-v18"
          }
        });
        console.log("[Scout Bridge] Wrote scout_intel → gatekeeper sweep will see this");
      } catch (bridgeErr) {
        console.warn("[Scout Bridge] Failed:", bridgeErr);
      }
    }

    await rpcBeat("scout", { last_run: new Date().toISOString(), findings: flagList.length, high: highCount });

    console.log("Scout v18 done in " + elapsed + "ms. Run " + (run.id || "unknown") + ". Flagged " + flagList.length + " (" + highCount + " high)");

    return new Response(JSON.stringify({
      run_id: run.id,
      research_question: researchFocus.question,
      research_reasoning: researchFocus.reasoning,
      sources_checked: scanStats.sources_checked,
      sources_failed: failures,
      hn_top_scanned: hnTop.length, hn_new_scanned: hnNew.length,
      github_repos_scanned: gh.length, arxiv_papers_scanned: arxiv.length,
      reddit_posts_scanned: reddit.length,
      items_flagged: flagList.length, high_relevance: highCount,
      elapsed_ms: elapsed
    }), { headers: { "Content-Type": "application/json" } });

  } catch (error) {
    console.error("Scout error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { "Content-Type": "application/json" } });
  }
});
