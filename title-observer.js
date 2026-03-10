(function () {
  const DEBOUNCE_MS = 1500;
  const MIN_TITLE_LENGTH = 20;
  const MAX_TITLE_LENGTH = 200;
  const MIN_TIME_ON_PAGE_SECONDS = 5;

  const GENERIC_TITLES = new Set([
    'youtube', 'spotify', 'twitter', 'x', 'reddit',
    'linkedin', 'github', 'google', 'new tab', 'loading...',
    'untitled', 'claude', 'chatgpt', 'perplexity',
  ]);

  function isJunkTitle(title) {
    if (!title) return true;
    if (title.length < MIN_TITLE_LENGTH) return true;
    if (title.length > MAX_TITLE_LENGTH) return true;
    const lower = title.toLowerCase().trim();
    if (GENERIC_TITLES.has(lower)) return true;
    const host = location.hostname.replace(/^www\./, '').split('.')[0].toLowerCase();
    if (lower === host) return true;
    if (title.trim().split(/\s+/).length < 3) return true;
    return false;
  }

  function stripSiteSuffix(title) {
    return title.replace(/\s*[-–|]\s*[^-–|]{3,40}$/, '').trim() || title.trim();
  }

  let lastSentTitle = '';
  let debounceTimer = null;
  let pageStartedAtMs = Date.now();
  let trackedUrl = location.href;
  let scrollSignalSentForPage = false;

  function maybeEmit(rawTitle) {
    const title = stripSiteSuffix(rawTitle);
    if (isJunkTitle(title)) return;
    if (title === lastSentTitle) return;
    lastSentTitle = title;
    try {
      chrome.runtime.sendMessage({
        type: 'TOPIC_SIGNAL_FROM_TITLE',
        signal_type: 'topic_signal',
        signal_value: title,
        metadata: {
          source: 'title_observer',
          domain: location.hostname,
          url: location.href,
          raw_title: rawTitle,
        },
      });
    } catch (err) {
      // Extension context invalidated — ignore
    }
  }

  function getScrollDepthPct() {
    const docEl = document.documentElement;
    const scrollHeight = Math.max(1, docEl ? docEl.scrollHeight : 1);
    const depth = Math.round(((window.scrollY + window.innerHeight) / scrollHeight) * 100);
    return Math.max(0, Math.min(100, depth));
  }

  function maybeEmitScrollDepth(rawTitle, urlForSignal) {
    if (scrollSignalSentForPage) return;
    const elapsedSeconds = Math.round((Date.now() - pageStartedAtMs) / 1000);
    if (elapsedSeconds < MIN_TIME_ON_PAGE_SECONDS) return;

    const title = stripSiteSuffix(rawTitle || document.title || '');
    if (isJunkTitle(title)) return;

    scrollSignalSentForPage = true;
    try {
      chrome.runtime.sendMessage({
        type: 'SCROLL_DEPTH_SIGNAL',
        signal_type: 'topic_signal',
        signal_value: title,
        metadata: {
          source: 'title_observer',
          domain: location.hostname,
          url: urlForSignal || trackedUrl || location.href,
          title: title,
          scroll_depth_pct: getScrollDepthPct(),
          time_on_page_seconds: elapsedSeconds,
        },
      });
    } catch (err) {
      // Extension context invalidated — ignore
    }
  }

  function resetPageTracking() {
    pageStartedAtMs = Date.now();
    trackedUrl = location.href;
    scrollSignalSentForPage = false;
    lastSentTitle = '';
  }

  function onTitleChange(newTitle) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => maybeEmit(newTitle), DEBOUNCE_MS);
  }

  // Watch document.title via MutationObserver on <title> element
  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(() => onTitleChange(document.title))
      .observe(titleEl, { childList: true });
  }

  // Also poll as fallback for SPAs that replace <title> entirely
  let lastPolledTitle = document.title;
  setInterval(() => {
    if (location.href !== trackedUrl) {
      maybeEmitScrollDepth(lastPolledTitle || document.title, trackedUrl);
      resetPageTracking();
      lastPolledTitle = document.title;
      onTitleChange(document.title);
      return;
    }
    if (document.title !== lastPolledTitle) {
      lastPolledTitle = document.title;
      onTitleChange(document.title);
    }
  }, 2000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      maybeEmitScrollDepth(document.title, trackedUrl);
    }
  });

  window.addEventListener('beforeunload', () => {
    maybeEmitScrollDepth(document.title, trackedUrl);
  });

  // Fire once on load
  onTitleChange(document.title);
})();
