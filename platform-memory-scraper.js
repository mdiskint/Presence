(function() {
  return; // disabled — platform memories are stale declarative data, not behavioral signal
  const SCRAPE_POLL_MS = 2000;
  let lastScrapeKey = "";
  let lastUrl = location.href;

const PLATFORM_EXTRACTORS = {
  claude: {
    SETTINGS_PATH_HINTS: ["/settings/capabilities", "/settings", "/preferences", "/account"],
    SELECTORS: {
      directItems: [
          'div.w-32.h-20',
          '[data-testid*="memory"]',
          '[class*="memory"]',
          '[aria-label*="memory" i]',
          '[data-qa*="memory"]',
      ],
      listContainers: [
        '[role="dialog"]',
        'main section',
        '[class*="memory"]',
      ],
      listItems: ['li', '[role="listitem"]', 'p'],
    },
  },
  chatgpt: {
    SETTINGS_PATH_HINTS: ["/#settings", "/settings"],
    SELECTORS: {
      directItems: [
        '[data-testid*="memory"]',
        '[class*="memory"]',
        '[aria-label*="memory" i]',
      ],
      listContainers: [
        '[role="dialog"]',
      ],
      listItems: [
        '[class*="text-token-text-primary"]',
      ],
    },
  },
};

  function getPlatform() {
    const host = location.hostname.toLowerCase();
    if (host.includes("claude.ai")) return "claude";
    if (host.includes("chatgpt.com") || host.includes("chat.openai.com")) return "chatgpt";
    return null;
  }

  function onPotentialSettingsPage(platform) {
    if (!platform) return false;
    const hints = PLATFORM_EXTRACTORS[platform].SETTINGS_PATH_HINTS;
    const full = `${location.pathname}${location.hash}`.toLowerCase();
    return hints.some((hint) => full.includes(hint.replace(/^\/+/, "/").toLowerCase()));
  }

  function normalizeMemoryText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

function isLikelyMemoryText(text) {
  if (!text) return false;
  if (text.length < 20) return false;
  if (text.length > 1200) return false;
  const lower = text.toLowerCase();
  if (lower.includes("delete memory") || lower.includes("add memory")) return false;
  if (lower.includes("saved memory") || lower.includes("saved memories")) return false;
  if (lower.includes("window.__oai") || lower.includes("requestanimationframe")) return false;
  if (lower.includes("date.now()") || lower.includes("function(")) return false;
  if (text.trim().split(/\s+/).length < 4) return false;
  return true;
}

  function collectByDirectSelectors(selectors) {
    const items = [];
    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        const text = normalizeMemoryText(node.textContent || "");
        if (isLikelyMemoryText(text)) items.push(text);
      }
    }
    return items;
  }

  function collectByContainerFallback(containerSelectors, itemSelectors) {
    const items = [];
    for (const cSel of containerSelectors) {
      const containers = document.querySelectorAll(cSel);
      for (const container of containers) {
        for (const iSel of itemSelectors) {
          const nodes = container.querySelectorAll(iSel);
          for (const node of nodes) {
            const text = normalizeMemoryText(node.textContent || "");
            if (isLikelyMemoryText(text)) items.push(text);
          }
        }
      }
    }
    return items;
  }

  function uniqueStrings(values) {
    return Array.from(new Set(values.map((v) => normalizeMemoryText(v)).filter(Boolean)));
  }

  async function sha256Hex(input) {
    const bytes = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const arr = Array.from(new Uint8Array(digest));
    return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function scrapePlatformMemories(reason = "auto") {
    const platform = getPlatform();
    if (!platform) return { success: false, reason: "unsupported_platform" };
    if (!onPotentialSettingsPage(platform)) return { success: false, reason: "not_settings_page" };

    const cfg = PLATFORM_EXTRACTORS[platform];
    const direct = collectByDirectSelectors(cfg.SELECTORS.directItems);
    const fallback = collectByContainerFallback(cfg.SELECTORS.listContainers, cfg.SELECTORS.listItems);
    const uniqueMemories = uniqueStrings([...direct, ...fallback]);

    const memories = [];
    for (const content of uniqueMemories) {
      const content_hash = await sha256Hex(`${platform}::${content}`);
      memories.push({ platform, content, content_hash });
    }

    const scrapeKey = `${platform}|${location.href}|${memories.length}|${memories.map((m) => m.content_hash).join(",")}`;
    if (scrapeKey === lastScrapeKey && reason === "auto") {
      return { success: true, deduped: true, platform, count: memories.length };
    }
    lastScrapeKey = scrapeKey;

    await chrome.runtime.sendMessage({
      type: "PLATFORM_MEMORIES_SCRAPED",
      platform,
      memories,
      pageUrl: location.href,
      scrapedAt: new Date().toISOString(),
    });

    return { success: true, platform, count: memories.length };
  }

  async function maybeAutoScrape() {
    const platform = getPlatform();
    if (!platform) return;
    if (!onPotentialSettingsPage(platform)) return;
    try {
      await scrapePlatformMemories("auto");
    } catch (err) {
      console.warn("[PLATFORM SCRAPER] auto scrape failed:", err?.message || err);
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "SCRAPE_PLATFORM_MEMORIES") {
      scrapePlatformMemories("command")
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err?.message || String(err) }));
      return true;
    }
    return false;
  });

  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      maybeAutoScrape();
      return;
    }
    maybeAutoScrape();
  }, SCRAPE_POLL_MS);

  if (document.readyState === "complete" || document.readyState === "interactive") {
    maybeAutoScrape();
  } else {
    window.addEventListener("DOMContentLoaded", maybeAutoScrape, { once: true });
  }
})();
