// ============================================================
// UPSIDE DOWN — background.js
// The Brain: orchestrates Claude, manages mission state,
// routes actions to content scripts.
// ============================================================

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-opus-4-6';
const API_KEY_STORAGE_KEY = 'ud_api_key';

// ============================================================
// SESSION STATE
// chrome.storage.session persists across tabs for the
// duration of the browser session. All tabs share this.
// ============================================================

async function getSession() {
  const result = await chrome.storage.session.get('ud_session');
  return result.ud_session || {
    history: [],
    mission: null,
    status: 'idle', // idle | working | awaiting_approval
    pendingActions: [],
    proposalText: null
  };
}

async function saveSession(session) {
  await chrome.storage.session.set({ ud_session: session });
}

async function clearSession() {
  await chrome.storage.session.remove('ud_session');
}

// ============================================================
// API KEY
// ============================================================

async function getApiKey() {
  const result = await chrome.storage.local.get(API_KEY_STORAGE_KEY);
  return result[API_KEY_STORAGE_KEY] || null;
}

// ============================================================
// CLAUDE
// ============================================================

async function askClaude(history, systemPrompt) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('No API key set. Open the panel and add your key.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: history
      }),
      signal: controller.signal
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Claude API error');
    return data.content[0].text;

  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// SYSTEM PROMPT
// ============================================================

function buildSystemPrompt(mission, pageContext, openTabs) {
  return `You are Upside Down, an AI agent that acts on web pages on behalf of the user.

${mission ? `CURRENT MISSION: ${mission}` : 'No active mission.'}

OPEN TABS (you can act on any of these):
${openTabs ? openTabs.map(t => `- "${t.title}" → ${t.url}`).join('\n') : 'Unknown'}

CURRENT PAGE CONTEXT:
${pageContext || 'No page context available.'}

You can respond in two ways:

1. ACTIONS — to interact with the page, respond with a JSON block:
\`\`\`json
{
  "actions": [
    {"type": "fill", "selector": "#search", "value": "white socks", "tabUrl": "google.com"},
    {"type": "click", "selector": "#submit", "tabUrl": "google.com"},
    {"type": "openTab", "url": "https://www.ticketmaster.com/search?q=LA+Kings"}
  ],
  "message": "Searching for white socks now.",
  "complete": false
}
\`\`\`

2. PROPOSAL — when you have found what the user asked for and need approval before executing a write action (purchase, post, send), respond with:
\`\`\`json
{
  "proposal": true,
  "actions": [
    {"type": "click", "selector": "#buy-now"}
  ],
  "message": "Found Hanes crew socks 6-pack for $12.99. Ready to purchase. Approve?",
  "complete": false
}
\`\`\`

3. COMPLETE — when the mission is done:
\`\`\`json
{
  "actions": [],
  "message": "Purchase complete. Order confirmed.",
  "complete": true
}
\`\`\`

RULES:
- Always wrap JSON in triple backticks
- ONLY use proposal: true for purchases (clicking buy/checkout/pay) and sending messages (clicking send/post/submit on a form that posts content)
- Reads, searches, navigation, and opening tabs do NOT require proposals
- Adding an item to a cart is NOT a purchase. After adding to cart, you MUST continue through the full checkout flow and send a proposal BEFORE clicking the final "Place order" / "Buy now" / "Complete purchase" button.
- NEVER say a purchase is complete unless the final order confirmation page is showing. "Added to cart" and "Proceeded to checkout" are NOT complete purchases.
- When sending a proposal, be precise about what will happen: "Click 'Place your order' to complete the $17.39 purchase" — not vague language like "proceed to checkout"
- Only set complete: true for a purchase mission when the order confirmation page confirms the order was placed, OR when you are reporting findings/results back to the user (non-purchase missions)
- Use openTab ONLY when visiting a site that doesn't have an open tab yet. If a tab for that domain is already open, use fill/click/key actions targeting that tabUrl instead.
- NEVER use the navigate action. It is disabled.
- Once you have an open tab for a site, do all work there — search, click through results, navigate product pages — using fill, click, and key actions with the correct tabUrl. Do not open a new tab for each page within the same site.
- After opening tabs and reading results, report back with complete: true and a summary
- Keep messages short and direct
- To press a key, use type "key" with field "value" (e.g. {"type": "key", "value": "Enter", "tabUrl": "google.com"}) — never use "pressKey"
- Always include tabUrl in every action — use a substring of the target tab's URL (e.g. "google.com", "amazon.com", "gmail.com")
- If acting on the user's current tab, use the URL shown in CURRENT PAGE CONTEXT
- For tabUrl, use only the domain (e.g. "google.com", "mail.google.com") — never include query parameters or paths
- When reporting findings, NEVER use navigate or any action that changes the user's current tab. Instead set complete: true and put the full summary in the message field.
- End your summary message with: "→ See tab: [site name]" so the user knows which tab has the full details.
- If you encounter a login wall, paywall, captcha, or any page requiring user input you cannot provide, do NOT navigate the user's tab. Instead, set complete: true and report what happened in the message field, telling the user which tab needs their attention.
- Be efficient. Combine actions when possible — search AND open tabs in the same step rather than separate steps. Aim to complete missions in 5 steps or fewer. If you need to navigate a purchase flow, go directly to the product rather than browsing.`;
}

// ============================================================
// ACTION EXECUTOR
// Sends actions to the target tab's content script
// ============================================================

async function executeActions(actions, fallbackTabId) {
  const results = [];
  const allTabs = await chrome.tabs.query({});

  for (const action of actions) {
    // Find target tab by tabUrl substring, fall back to fallbackTabId
    let targetTabId = fallbackTabId;
    if (action.tabUrl) {
      const match = allTabs.find(t => t.url && t.url.includes(action.tabUrl));
      if (match) targetTabId = match.id;
    }

    try {
      const result = await chrome.tabs.sendMessage(targetTabId, {
        type: 'EXECUTE_ACTION',
        action
      });
      results.push(result);
    } catch (err) {
      // Content script not loaded — inject it and retry once
      console.warn('[UD] No content script on tab, injecting...', err.message);
      try {
        await chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          files: ['content/content.js']
        });
        const result = await chrome.tabs.sendMessage(targetTabId, {
          type: 'EXECUTE_ACTION',
          action
        });
        results.push(result);
      } catch (retryErr) {
        console.error('[UD] executeActions error after inject:', retryErr.message, action);
        results.push({ success: false, error: retryErr.message });
      }
    }
  }
  return results;
}

async function runAgenticLoop(session, activeTab, openTabs, maxSteps = 20) {
  let steps = 0;

  while (steps < maxSteps) {
    steps++;

    const pageContext = await getTabContext(activeTab.id);
    const freshTabs = await chrome.tabs.query({});
    const currentOpenTabs = freshTabs
      .filter(t => t.url && t.url.startsWith('http'))
      .map(t => ({ title: t.title, url: t.url }));

    const systemPrompt = buildSystemPrompt(session.mission, pageContext, currentOpenTabs);
    const responseText = await askClaude(session.history, systemPrompt);
    const parsed = parseClaudeResponse(responseText);
    session.history.push({ role: 'assistant', content: responseText });
    console.log(`[UD] Loop step ${steps}:`, JSON.stringify(parsed));

    // Proposal — stop and ask user
    if (parsed.proposal) {
      session.status = 'awaiting_approval';
      session.pendingActions = parsed.actions;
      session.proposalText = parsed.message;
      await saveSession(session);
      chrome.runtime.sendMessage({
        type: 'STATUS_UPDATE',
        status: 'awaiting_approval',
        message: parsed.message
      }).catch(() => {});
      return { status: 'awaiting_approval', message: parsed.message };
    }

    // Execute actions
    if (parsed.actions?.length > 0) {
      for (const action of parsed.actions) {
        if (action.type === 'openTab') {
          const newTab = await chrome.tabs.create({ url: action.url, active: false, selected: false });
          await new Promise(resolve => {
            chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
              if (tabId === newTab.id && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            });
            setTimeout(resolve, 5000);
          });
          // Read the new tab's content immediately and inject into history
          const newTabContext = await getTabContextById(newTab.id);
          if (newTabContext) {
            session.history.push({
              role: 'user',
              content: `New tab loaded: "${newTabContext.title}" (${newTabContext.url})\n\nPage content:\n${newTabContext.body}`
            });
            await saveSession(session);
          }
        }
      }

      // Execute non-openTab actions
      const regularActions = parsed.actions.filter(a => a.type !== 'openTab');
      if (regularActions.length > 0) {
        await executeActions(regularActions, activeTab.id);
      }
    }

    // Complete — report back and stop
    if (parsed.complete) {
      session.status = 'idle';
      session.mission = null;
      await saveSession(session);
      return { status: 'idle', message: parsed.message };
    }

    // No actions and not complete — Claude is thinking/reporting, we're done
    if (!parsed.actions || parsed.actions.length === 0) {
      session.status = 'idle';
      await saveSession(session);
      return { status: 'idle', message: parsed.message };
    }

    // Wait for page to settle before next step
    await new Promise(r => setTimeout(r, 3000));

    // Feed updated context back
    const updatedContext = await getTabContext(activeTab.id);
    session.history.push({
      role: 'user',
      content: `Page updated. Current context:\n${updatedContext}\n\nContinue the mission.`
    });
    await saveSession(session);
  }

  return { status: 'idle', message: 'Reached maximum steps.' };
}

async function actOnBackgroundTab(action) {
  const tabs = await chrome.tabs.query({});
  const target = tabs.find(t => t.url && t.url.includes(action.url));
  if (!target) return { success: false, error: `No tab found matching: ${action.url}` };

  const results = await chrome.scripting.executeScript({
    target: { tabId: target.id },
    func: (innerAction) => {
      const el = document.querySelector(innerAction.selector);
      if (!el) return { success: false, error: `Selector not found: ${innerAction.selector}` };
      if (innerAction.type === 'fill') {
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const nativeValueSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        nativeValueSetter.call(el, innerAction.value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { success: true };
      }
      if (innerAction.type === 'click') {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { success: true };
      }
      return { success: false, error: `Unknown action type: ${innerAction.type}` };
    },
    args: [action]
  });

  return results[0]?.result || { success: false, error: 'Script execution failed' };
}

// ============================================================
// GET PAGE CONTEXT from a tab
// ============================================================

async function getTabContext(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        return {
          url: window.location.href,
          title: document.title,
          body: document.body.innerText.slice(0, 3000)
        };
      }
    });
    return JSON.stringify(results[0]?.result || {});
  } catch {
    return 'Could not read page context.';
  }
}

async function getTabContextById(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        url: window.location.href,
        title: document.title,
        body: document.body.innerText.slice(0, 3000)
      })
    });
    return results[0]?.result || null;
  } catch {
    return null;
  }
}

// ============================================================
// PARSE CLAUDE RESPONSE
// Extracts JSON block from Claude's text response
// ============================================================

function parseClaudeResponse(text) {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match) return { actions: [], message: text, complete: false, proposal: false };
  try {
    return JSON.parse(match[1]);
  } catch {
    return { actions: [], message: text, complete: false, proposal: false };
  }
}

// ============================================================
// MAIN MESSAGE HANDLER
// Receives messages from panel.js
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(err => {
    sendResponse({ error: err.message });
  });
  return true; // keep channel open for async response
});

async function handleMessage(message, sender) {
  const session = await getSession();

  // --- Save API key ---
  if (message.type === 'SET_API_KEY') {
    await chrome.storage.local.set({ [API_KEY_STORAGE_KEY]: message.key });
    return { success: true };
  }

  // --- Get current status ---
  if (message.type === 'GET_STATUS') {
    return session;
  }

  // --- User sends a new message or task ---
  if (message.type === 'USER_MESSAGE') {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const pageContext = await getTabContext(activeTab.id);
    const allTabs = await chrome.tabs.query({});
    const openTabs = allTabs
      .filter(t => t.url && t.url.startsWith('http'))
      .map(t => ({ title: t.title, url: t.url }));

    session.history.push({ role: 'user', content: message.text });
    if (!session.mission) session.mission = message.text;
    session.status = 'working';
    await saveSession(session);

    // Notify panel we're working
    chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status: 'working' }).catch(() => {});

    const result = await runAgenticLoop(session, activeTab, openTabs);
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (currentTab) {
      chrome.tabs.sendMessage(currentTab.id, {
        type: 'UD_STATUS_UPDATE',
        status: result.status,
        message: result.message
      }).catch(() => {});
    }
    return result;
  }

  // --- User approves a proposal ---
  if (message.type === 'APPROVE') {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (session.pendingActions?.length > 0) {
      await executeActions(session.pendingActions, activeTab.id);
    }
    session.status = 'idle';
    session.pendingActions = [];
    session.proposalText = null;
    session.mission = null;
    await saveSession(session);
    return { success: true, message: 'Actions executed.' };
  }

  // --- User declines with a note ---
  if (message.type === 'DECLINE') {
    session.pendingActions = [];
    session.proposalText = null;
    session.history.push({ role: 'user', content: `Declined. Note: ${message.note}` });
    session.status = 'working';
    await saveSession(session);

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const pageContext = await getTabContext(activeTab.id);
    const allTabs = await chrome.tabs.query({});
    const openTabs = allTabs
      .filter(t => t.url && t.url.startsWith('http'))
      .map(t => ({ title: t.title, url: t.url }));
    const systemPrompt = buildSystemPrompt(session.mission, pageContext, openTabs);
    const responseText = await askClaude(session.history, systemPrompt);
    const parsed = parseClaudeResponse(responseText);

    session.history.push({ role: 'assistant', content: responseText });

    if (parsed.proposal) {
      session.status = 'awaiting_approval';
      session.pendingActions = parsed.actions;
      session.proposalText = parsed.message;
      await saveSession(session);
      chrome.runtime.sendMessage({
        type: 'STATUS_UPDATE',
        status: 'awaiting_approval',
        message: parsed.message
      }).catch(() => {});
      return { status: 'awaiting_approval', message: parsed.message };
    }

    await saveSession(session);
    return { status: session.status, message: parsed.message };
  }

  // --- Clear session ---
  if (message.type === 'CLEAR') {
    await clearSession();
    return { success: true };
  }

  return { error: 'Unknown message type' };
}
