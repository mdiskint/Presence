// Side Panel mode: UI is rendered by Chrome Side Panel API via panel/panel.html.

// ============================================================
// UPSIDE DOWN — panel/panel.js
// The Shell: handles UI state, sends messages to background.js
// ============================================================

const statusBar      = document.getElementById('status-bar');
const messageDisplay = document.getElementById('message-display');
const taskInput      = document.getElementById('task-input'); // legacy optional
const sendBtn        = document.getElementById('send-btn');   // legacy optional
const approvalPanel  = document.getElementById('approval-panel');
const declineNote    = document.getElementById('decline-note');
const approveBtn     = document.getElementById('approve-btn');
const declineBtn     = document.getElementById('decline-btn');
const apiKeySection  = document.getElementById('api-key-section');
const apiKeyInput    = document.getElementById('api-key-input');
const saveKeyBtn     = document.getElementById('save-key-btn');
const statusText      = document.getElementById('status-text');
const settingsToggle  = document.getElementById('settings-toggle');
const recoveryRow     = document.getElementById('recovery-row');
const recoverBtn      = document.getElementById('recover-btn');
const teachPanel      = document.getElementById('teach-panel');
const showMeBtn       = document.getElementById('show-me-btn');
const cancelTeachBtn  = document.getElementById('cancel-teach-btn');
const askPanel        = document.getElementById('ask-panel');
const askAnswer       = document.getElementById('ask-answer');
const answerBtn       = document.getElementById('answer-btn');
const cancelAskBtn    = document.getElementById('cancel-ask-btn');

// ============================================================
// UI STATE
// ============================================================

function setStatus(status, message) {
  // Status bar color
  statusBar.className = '';
  if (status === 'working')              statusBar.classList.add('working');
  if (status === 'awaiting_approval')    statusBar.classList.add('approval');
  if (status === 'awaiting_user_answer') statusBar.classList.add('needs-help');
  if (status === 'needs_help')           statusBar.classList.add('needs-help');

  // Status text
  const labels = {
    idle: 'idle',
    working: 'working...',
    awaiting_approval: 'ready for approval',
    awaiting_user_answer: 'has a question',
    needs_help: 'needs your help'
  };
  statusText.textContent = labels[status] || status;

  // Show message if provided
  if (message) {
    messageDisplay.textContent = message;
    messageDisplay.classList.add('visible');
  }

  // Show/hide approval panel
  if (status === 'awaiting_approval') {
    approvalPanel.classList.add('visible');
    if (sendBtn) sendBtn.disabled = true;
  } else {
    approvalPanel.classList.remove('visible');
    if (sendBtn) sendBtn.disabled = false;
    declineNote.value = '';
  }

  // Show/hide ask panel
  if (status === 'awaiting_user_answer') {
    askPanel.classList.add('visible');
    if (sendBtn) sendBtn.disabled = true;
    if (askAnswer) {
      askAnswer.value = '';
      askAnswer.focus();
    }
  } else {
    askPanel.classList.remove('visible');
  }

  // Show/hide teach panel
  if (status === 'needs_help') {
    teachPanel.classList.add('visible');
    if (sendBtn) sendBtn.disabled = true;
  } else {
    teachPanel.classList.remove('visible');
  }

  // Clear queue log when returning to idle (after a delay so user can read)
  if (status === 'idle' && queueLog && queueLog.classList.contains('visible')) {
    setTimeout(() => {
      if (!isQueueMode) {
        queueLog.classList.remove('visible');
        queueLog.innerHTML = '';
      }
    }, 10000); // keep visible 10s after completion
  }
}

function showMessage(text) {
  messageDisplay.textContent = text;
  messageDisplay.classList.add('visible');
}

function showRecovery(visible) {
  if (!recoveryRow) return;
  if (visible) recoveryRow.classList.add('visible');
  else recoveryRow.classList.remove('visible');
}

function formatRuntimeError(err) {
  const msg = String(err?.message || err || '');
  if (msg.includes('Extension context invalidated')) {
    return 'Extension updated/reloaded. Refresh this tab, then try again.';
  }
  return msg || 'Unknown error';
}

// ============================================================
// SEND TASK
// ============================================================

async function sendTask(inputText) {
  const text = (typeof inputText === 'string' ? inputText : (taskInput ? taskInput.value : '')).trim();
  if (!text) return;

  if (taskInput) {
    taskInput.value = '';
  }
  if (messageDisplay) {
    messageDisplay.classList.add('visible');
  }
  setStatus('working');
  showMessage('Working...');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'USER_MESSAGE',
      text
    });

    if (response.error) {
      showMessage(`Error: ${response.error}`);
      showRecovery(String(response.error).includes('Extension context invalidated'));
      setStatus('idle');
      return;
    }

    if (response.type === 'authWall') {
      showMessage(response.message);
      setStatus('idle');
      return;
    }

    // Track queue mode for skip button
    if (response.isQueue) {
      isQueueMode = true;
      if (cancelAskBtn) cancelAskBtn.textContent = 'Skip Task';
    } else {
      isQueueMode = false;
      if (cancelAskBtn) cancelAskBtn.textContent = 'Cancel';
    }

    setStatus(response.status, response.message);
    showRecovery(false);

  } catch (err) {
    showMessage(`Error: ${formatRuntimeError(err)}`);
    showRecovery(String(err?.message || err || '').includes('Extension context invalidated'));
    setStatus('idle');
  }
}

// ============================================================
// APPROVE
// ============================================================

async function approve() {
  setStatus('working');
  showMessage('Executing...');

  try {
    const response = await chrome.runtime.sendMessage({ type: 'APPROVE' });
    if (response.error) {
      showMessage(`Error: ${response.error}`);
      showRecovery(String(response.error).includes('Extension context invalidated'));
    } else {
      showMessage(response.message || 'Done.');
      showRecovery(false);
    }
    setStatus('idle');
  } catch (err) {
    showMessage(`Error: ${formatRuntimeError(err)}`);
    showRecovery(String(err?.message || err || '').includes('Extension context invalidated'));
    setStatus('idle');
  }
}

// ============================================================
// DECLINE
// ============================================================

async function decline() {
  const note = declineNote.value.trim() || 'Try again with a different option.';
  setStatus('working');
  showMessage('Retrying...');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'DECLINE',
      note
    });

    if (response.error) {
      showMessage(`Error: ${response.error}`);
      showRecovery(String(response.error).includes('Extension context invalidated'));
      setStatus('idle');
      return;
    }

    if (response.type === 'authWall') {
      showMessage(response.message);
      setStatus('idle');
      return;
    }

    setStatus(response.status, response.message);
    showRecovery(false);

  } catch (err) {
    showMessage(`Error: ${formatRuntimeError(err)}`);
    showRecovery(String(err?.message || err || '').includes('Extension context invalidated'));
    setStatus('idle');
  }
}

// ============================================================
// API KEY
// ============================================================

async function saveApiKey() {
  const key = apiKeyInput.value.trim();
  if (!key) return;

  try {
    await chrome.runtime.sendMessage({ type: 'SET_API_KEY', key });
    apiKeyInput.value = '';
    apiKeySection.classList.remove('visible');
    showMessage('API key saved.');
  } catch (err) {
    showMessage(`Error: ${formatRuntimeError(err)}`);
  }
}

if (settingsToggle) {
  settingsToggle.addEventListener('click', () => {
    apiKeySection.classList.toggle('visible');
  });
}

if (saveKeyBtn) saveKeyBtn.addEventListener('click', saveApiKey);

// ============================================================
// EVENT LISTENERS
// ============================================================

if (sendBtn) sendBtn.addEventListener('click', sendTask);

if (taskInput) {
  taskInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendTask();
    }
  });
}

if (approveBtn) approveBtn.addEventListener('click', approve);
if (declineBtn) declineBtn.addEventListener('click', decline);
if (recoverBtn) {
  recoverBtn.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'RELOAD_ACTIVE_TAB' });
      showMessage('Reloading tab...');
      showRecovery(false);
    } catch (err) {
      showMessage(`Error: ${formatRuntimeError(err)}`);
    }
  });
}

// ============================================================
// USER ANSWER (askUser response)
// ============================================================

async function sendAnswer() {
  const text = askAnswer.value.trim();
  if (!text) return;

  askAnswer.value = '';
  setStatus('working');
  showMessage('Got it, continuing...');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'USER_ANSWER',
      text
    });

    if (response.error) {
      showMessage(`Error: ${response.error}`);
      showRecovery(String(response.error).includes('Extension context invalidated'));
      setStatus('idle');
      return;
    }

    // Track queue mode for skip button
    if (response.isQueue) {
      isQueueMode = true;
      if (cancelAskBtn) cancelAskBtn.textContent = 'Skip Task';
    } else {
      isQueueMode = false;
      if (cancelAskBtn) cancelAskBtn.textContent = 'Cancel';
    }

    setStatus(response.status, response.message);
    showRecovery(false);
  } catch (err) {
    showMessage(`Error: ${formatRuntimeError(err)}`);
    showRecovery(String(err?.message || err || '').includes('Extension context invalidated'));
    setStatus('idle');
  }
}

if (answerBtn) answerBtn.addEventListener('click', sendAnswer);

if (askAnswer) {
  askAnswer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAnswer();
    }
  });
}

let isQueueMode = false;

if (cancelAskBtn) {
  cancelAskBtn.addEventListener('click', async () => {
    try {
      if (isQueueMode) {
        // In queue mode, skip the parked task
        const response = await chrome.runtime.sendMessage({ type: 'SKIP_PARKED_TASK' });
        if (response.status === 'awaiting_user_answer') {
          setStatus(response.status, response.message);
        } else {
          setStatus('idle', response.message);
          isQueueMode = false;
          cancelAskBtn.textContent = 'Cancel';
        }
      } else {
        await chrome.runtime.sendMessage({ type: 'CANCEL_ASK' });
        setStatus('idle');
        showMessage('Cancelled.');
      }
    } catch (err) {
      showMessage(`Error: ${formatRuntimeError(err)}`);
    }
  });
}

// ============================================================
// TEACH / "SHOW ME"
// ============================================================

if (showMeBtn) {
  showMeBtn.addEventListener('click', async () => {
    showMessage('Switch to the target tab and click the element...');
    showMeBtn.disabled = true;
    showMeBtn.textContent = 'Watching...';

    try {
      const response = await chrome.runtime.sendMessage({ type: 'START_TEACH_CAPTURE' });
      if (response?.error) {
        showMessage(`Error: ${response.error}`);
        showMeBtn.disabled = false;
        showMeBtn.textContent = '\ud83c\udfaf Show Me';
      }
      // If success, we wait for TEACH_CAPTURE_RESULT to come back
      // which will trigger a STATUS_UPDATE -> working -> resuming
    } catch (err) {
      showMessage(`Error: ${formatRuntimeError(err)}`);
      showMeBtn.disabled = false;
      showMeBtn.textContent = '\ud83c\udfaf Show Me';
    }
  });
}

if (cancelTeachBtn) {
  cancelTeachBtn.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'CANCEL_TEACH' });
      setStatus('idle');
      showMessage('Cancelled.');
      showMeBtn.disabled = false;
      showMeBtn.textContent = '\ud83c\udfaf Show Me';
    } catch (err) {
      showMessage(`Error: ${formatRuntimeError(err)}`);
    }
  });
}

// ============================================================
// INIT — restore status on open
// ============================================================

async function init() {
  try {
    const session = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (session && session.status) {
      setStatus(session.status, session.proposalText || null);
    }
  } catch {
    // background not ready yet, fine
  }
}

// ── Drag handle — sends mouse position to parent page ──
const dragHandle = document.getElementById('drag-handle');
if (dragHandle) {
  dragHandle.addEventListener('mousedown', (e) => {
    window.parent.postMessage({
      type: 'UD_DRAG_START',
      x: e.screenX,
      y: e.screenY
    }, '*');
    e.preventDefault();
  });
}
document.addEventListener('mouseup', () => {
  window.parent.postMessage({ type: 'UD_DRAG_END' }, '*');
});

function applyStatusUpdate(status, message) {
  setStatus(status, message);
  if (status !== 'needs_help' && showMeBtn) {
    showMeBtn.disabled = false;
    showMeBtn.textContent = '\ud83c\udfaf Show Me';
  }
}

window.addEventListener('message', (e) => {
  if (e.data?.type === 'UD_STATUS_UPDATE') {
    applyStatusUpdate(e.data.status, e.data.message);
  }
});

// ============================================================
// QUEUE MISSION LOG
// ============================================================

const queueLog = document.getElementById('queue-log');

function renderQueueLog(tasks, queueStatus) {
  if (!queueLog || !tasks || tasks.length === 0) {
    if (queueLog) queueLog.classList.remove('visible');
    return;
  }

  const statusEmoji = (status) => {
    switch (status) {
      case 'completed': return '\u2705';
      case 'failed':    return '\u274c';
      case 'parked':    return '\u23f8\ufe0f';
      case 'running':   return '\ud83d\udd04';
      case 'pending':   return '\u2b55';
      default:          return '\u2b55';
    }
  };

  const truncate = (str, len) => str && str.length > len ? str.slice(0, len) + '\u2026' : (str || '');

  let html = tasks.map(t => {
    const resultLine = t.status === 'completed' && t.result
      ? `<div class="result">${truncate(t.result, 60)}</div>`
      : t.status === 'parked' && t.parkedQuestion
        ? `<div class="result">${truncate(t.parkedQuestion, 60)}</div>`
        : t.status === 'failed' && t.error
          ? `<div class="result">${truncate(t.error, 60)}</div>`
          : '';

    return `<div class="queue-task ${t.status}">
      <span class="emoji">${statusEmoji(t.status)}</span>
      <div>
        <div class="mission">${t.id}. ${truncate(t.mission, 50)}</div>
        ${resultLine}
      </div>
    </div>`;
  }).join('');

  if (queueStatus === 'completed') {
    html += '<div style="color:#4ade80;font-size:11px;margin-top:6px;text-align:center;">\u2714 Batch complete \u2014 see report tab</div>';
  } else if (queueStatus === 'parked_waiting') {
    html += '<div style="color:#fbbf24;font-size:11px;margin-top:6px;text-align:center;">\u23f8 Waiting for your help on parked tasks</div>';
  }

  queueLog.innerHTML = html;
  queueLog.classList.add('visible');
  queueLog.scrollTop = queueLog.scrollHeight;
}

// Listen for QUEUE_UPDATE from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'QUEUE_UPDATE') {
    renderQueueLog(msg.tasks, msg.queueStatus);
  }
  if (msg.type === 'STATUS_UPDATE') {
    applyStatusUpdate(msg.status, msg.message);
  }
});

init();

// === PRESENCE DIRECTIVE + NOTIFICATIONS ===
const SUPABASE_URL_STORAGE_KEY = 'supabase_url';
const SUPABASE_ANON_KEY_STORAGE_KEY = 'supabase_anon_key';
const USER_ID_STORAGE_KEY = 'user_id';
const SETUP_COMPLETE_STORAGE_KEY = 'setup_complete';
var displayedPresenceNotifications = [];
var dismissedPresenceNotificationIds = new Set();
var runtimeConfig = null;

function supabaseAuthHeaders() {
  if (!runtimeConfig?.anonKey) throw new Error('Supabase anon key missing. Complete setup first.');
  return {
    'Authorization': 'Bearer ' + runtimeConfig.anonKey,
    'Content-Type': 'application/json',
    'apikey': runtimeConfig.anonKey,
    'x-user-id': runtimeConfig.userId || ''
  };
}

function getSupabaseUrl() {
  if (!runtimeConfig?.url) throw new Error('Supabase URL missing. Complete setup first.');
  return runtimeConfig.url;
}

async function updateStatusBar() {
  console.log('[StatusBar] running, url:', typeof getSupabaseUrl === 'function' ? getSupabaseUrl() : 'NO FUNCTION');

  const url = `${getSupabaseUrl()}/rest/v1/gatekeeper_runs?select=run_at,mode_classified,sonnet_decision,opus_fired,signals_processed,notes&order=run_at.desc&limit=1`;
  const headers = supabaseAuthHeaders ? supabaseAuthHeaders() : {};

  console.log('[StatusBar] fetch url:', url);
  console.log('[StatusBar] headers:', JSON.stringify(headers));

  try {
    const resp = await fetch(url, { headers });
    console.log('[StatusBar] response status:', resp.status);
    const text = await resp.text();
    console.log('[StatusBar] response body:', text.slice(0, 300));

    if (!resp.ok) {
      document.getElementById('status-mode').textContent = `error ${resp.status}`;
      return;
    }

    const data = JSON.parse(text);
    if (!data || !data[0]) {
      document.getElementById('status-mode').textContent = 'no data';
      return;
    }

    const row = data[0];

    const dot = document.getElementById('status-dot');
    const modeEl = document.getElementById('status-mode');
    const timeEl = document.getElementById('status-time');
    const reasonPanel = document.getElementById('status-reason-panel');

    if (!dot || !modeEl || !timeEl || !reasonPanel) return;

    const modeMap = {
      focused:   { color: '#4a9eff', label: 'focused' },
      fidgeting: { color: '#f5a623', label: 'fidgeting' },
      away:      { color: '#333',    label: 'away' },
    };
    const modeInfo = modeMap[row.mode_classified] || { color: '#444', label: row.mode_classified || 'unknown' };
    dot.style.background = modeInfo.color;
    modeEl.textContent = 'watching · ' + modeInfo.label;
    modeEl.style.color = modeInfo.color;

    const secsAgo = Math.round((Date.now() - new Date(row.run_at).getTime()) / 1000);
    timeEl.textContent = secsAgo < 120 ? (secsAgo + 's ago') : (Math.round(secsAgo / 60) + 'm ago');

    function humanizeReason(entry) {
      if (entry.opus_fired) return 'Presence just spoke.';
      if (entry.sonnet_decision === 'skip_no_signals') return 'No activity in the window.';
      if (entry.sonnet_decision === 'skip_not_novel') return entry.notes || 'Nothing new enough to say.';
      if (entry.sonnet_decision === 'skip_mode_away') return "You're away — holding.";
      return entry.notes || 'Staying quiet.';
    }
    reasonPanel.textContent = humanizeReason(row);

  } catch (e) {
    console.error('[StatusBar] exception:', e.message, e.stack);
    document.getElementById('status-mode').textContent = 'exception';
  }
}

async function askPresence() {
  const btn = document.getElementById('ask-presence-btn');
  const responseEl = document.getElementById('ask-presence-response');
  if (!btn || !responseEl) return;

  btn.textContent = 'thinking...';
  btn.disabled = true;
  responseEl.style.display = 'none';

  try {
    if (!runtimeConfig || !runtimeConfig.url || !runtimeConfig.anonKey) {
      throw new Error('config_missing');
    }

    const resp = await fetch(getSupabaseUrl() + '/functions/v1/presence-gatekeeper', {
      method: 'POST',
      headers: supabaseAuthHeaders(),
      body: JSON.stringify({
        trigger: 'status_request',
        user_id: runtimeConfig.userId || null
      })
    });

    if (!resp.ok) {
      throw new Error('HTTP ' + resp.status);
    }

    const data = await resp.json();
    responseEl.textContent = data.status_summary || 'Nothing to report right now.';
    responseEl.style.display = 'block';
    btn.textContent = 'Ask again';
  } catch (e) {
    responseEl.textContent = 'Could not reach Presence.';
    responseEl.style.display = 'block';
    btn.textContent = 'What are you seeing?';
  } finally {
    btn.disabled = false;
  }
}

const askPresenceBtn = document.getElementById('ask-presence-btn');
if (askPresenceBtn) {
  askPresenceBtn.addEventListener('click', askPresence);
}

const statusWhyBtn = document.getElementById('status-why-btn');
if (statusWhyBtn) {
  statusWhyBtn.addEventListener('click', () => {
    const panel = document.getElementById('status-reason-panel');
    if (!panel) return;
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });
}

const directiveActiveEl = document.getElementById('directive-active');
const directiveEditorEl = document.getElementById('directive-editor');
const directiveTextEl = document.getElementById('directive-text');
const directiveMetaEl = document.getElementById('directive-meta');
const directiveInputEl = document.getElementById('directive-input');
const directiveSubmitBtn = document.getElementById('directive-submit-btn');
const directiveUpdateBtn = document.getElementById('directive-update-btn');
const directiveClearBtn = document.getElementById('directive-clear-btn');
const intakeScreenEl = document.getElementById('intake-screen');
const intakeFileInputEl = document.getElementById('intake-file-input');
const intakeUploadBtnEl = document.getElementById('intake-upload-btn');
const intakeSkipBtnEl = document.getElementById('intake-skip-btn');
const intakeProgressEl = document.getElementById('intake-progress');
const intakeResultEl = document.getElementById('intake-result');
const setupScreenEl = document.getElementById('setup-screen');
const setupUrlInputEl = document.getElementById('setup-supabase-url');
const setupAnonKeyInputEl = document.getElementById('setup-supabase-anon-key');
const setupContinueBtnEl = document.getElementById('setup-continue-btn');
const setupErrorEl = document.getElementById('setup-error');
const presenceDirectivePanelEl = document.getElementById('presence-directive-panel');
const outputFeedEl = document.getElementById('output-feed');
const footerEl = document.getElementById('footer');
let normalPopupInitialized = false;

async function loadRuntimeConfig() {
  const data = await chrome.storage.local.get([
    SUPABASE_URL_STORAGE_KEY,
    SUPABASE_ANON_KEY_STORAGE_KEY,
    USER_ID_STORAGE_KEY,
    SETUP_COMPLETE_STORAGE_KEY
  ]);
  const url = String(data[SUPABASE_URL_STORAGE_KEY] || '').trim().replace(/\/+$/, '');
  const anonKey = String(data[SUPABASE_ANON_KEY_STORAGE_KEY] || '').trim();
  const userId = String(data[USER_ID_STORAGE_KEY] || '').trim();
  const setupComplete = Boolean(data[SETUP_COMPLETE_STORAGE_KEY]);
  runtimeConfig = { url, anonKey, userId, setupComplete };
  return runtimeConfig;
}

function isConfigReady() {
  return Boolean(runtimeConfig && runtimeConfig.setupComplete && runtimeConfig.url && runtimeConfig.anonKey && runtimeConfig.userId);
}

function relativeTimeFromIso(isoString) {
  if (!isoString) return '';
  const dt = new Date(isoString);
  if (Number.isNaN(dt.getTime())) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - dt.getTime()) / 1000));
  if (seconds < 60) return 'Set just now';
  if (seconds < 3600) return 'Set ' + Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return 'Set ' + Math.floor(seconds / 3600) + 'h ago';
  return 'Set ' + Math.floor(seconds / 86400) + 'd ago';
}

function renderDirectiveState(directive, directiveSetAt) {
  const hasDirective = Boolean(String(directive || '').trim());
  if (hasDirective) {
    directiveActiveEl && directiveActiveEl.classList.remove('directive-hidden');
    directiveTextEl && (directiveTextEl.textContent = String(directive).trim());
    directiveMetaEl && (directiveMetaEl.textContent = relativeTimeFromIso(directiveSetAt));
    if (directiveEditorEl) directiveEditorEl.classList.add('directive-hidden');
    if (directiveInputEl) directiveInputEl.value = '';
    if (directiveSubmitBtn) directiveSubmitBtn.textContent = 'Set';
    return;
  }

  directiveActiveEl && directiveActiveEl.classList.add('directive-hidden');
  if (directiveEditorEl) directiveEditorEl.classList.remove('directive-hidden');
  if (directiveSubmitBtn) directiveSubmitBtn.textContent = 'Set';
}

async function fetchPrimeDirective() {
  const response = await fetch(
    getSupabaseUrl() + '/rest/v1/presence_state?id=eq.1&select=prime_directive,directive_set_at&limit=1',
    {
      headers: supabaseAuthHeaders()
    }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('directive fetch failed: HTTP ' + response.status + (detail ? ' ' + detail : ''));
  }
  const rows = await response.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  return {
    primeDirective: row?.prime_directive || null,
    directiveSetAt: row?.directive_set_at || null
  };
}

async function setPrimeDirective(directive) {
  const response = await fetch(getSupabaseUrl() + '/functions/v1/presence-gatekeeper', {
    method: 'POST',
    headers: supabaseAuthHeaders(),
    body: JSON.stringify({
      action: 'set_directive',
      directive: directive,
      user_id: runtimeConfig?.userId || null
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('directive set failed: HTTP ' + response.status + (detail ? ' ' + detail : ''));
  }
}

function parseTruthySetting(raw) {
  var value = String(raw || '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

async function hasOnboardingComplete() {
  const response = await fetch(
    getSupabaseUrl() + '/rest/v1/hearth_settings?select=value&key=eq.onboarding_complete&limit=1',
    { headers: supabaseAuthHeaders() }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('onboarding flag read failed: HTTP ' + response.status + (detail ? ' ' + detail : ''));
  }
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return parseTruthySetting(rows[0] && rows[0].value);
}

function setIntakeMode(active) {
  if (setupScreenEl) setupScreenEl.classList.add('setup-hidden');
  if (intakeScreenEl) intakeScreenEl.classList.toggle('intake-hidden', !active);
  if (presenceDirectivePanelEl) presenceDirectivePanelEl.style.display = active ? 'none' : '';
  if (outputFeedEl) outputFeedEl.style.display = active ? 'none' : '';
  if (messageDisplay) messageDisplay.style.display = active ? 'none' : '';
  if (queueLog) queueLog.style.display = active ? 'none' : '';
  if (recoveryRow) recoveryRow.style.display = active ? 'none' : '';
  if (approvalPanel) approvalPanel.style.display = active ? 'none' : '';
  if (askPanel) askPanel.style.display = active ? 'none' : '';
  if (teachPanel) teachPanel.style.display = active ? 'none' : '';
  if (apiKeySection) apiKeySection.style.display = active ? 'none' : '';
  if (footerEl) footerEl.style.display = active ? 'none' : '';
}

function setSetupMode(active) {
  if (setupScreenEl) setupScreenEl.classList.toggle('setup-hidden', !active);
  if (intakeScreenEl) intakeScreenEl.classList.add('intake-hidden');
  if (presenceDirectivePanelEl) presenceDirectivePanelEl.style.display = active ? 'none' : '';
  if (outputFeedEl) outputFeedEl.style.display = active ? 'none' : '';
  if (messageDisplay) messageDisplay.style.display = active ? 'none' : '';
  if (queueLog) queueLog.style.display = active ? 'none' : '';
  if (recoveryRow) recoveryRow.style.display = active ? 'none' : '';
  if (approvalPanel) approvalPanel.style.display = active ? 'none' : '';
  if (askPanel) askPanel.style.display = active ? 'none' : '';
  if (teachPanel) teachPanel.style.display = active ? 'none' : '';
  if (apiKeySection) apiKeySection.style.display = active ? 'none' : '';
  if (footerEl) footerEl.style.display = active ? 'none' : '';
}

function estimateBatchCount(rawJson) {
  try {
    var parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return 1;
    return Math.max(1, Math.ceil(parsed.length / 20));
  } catch (_) {
    return 1;
  }
}

async function processIntakeFile(rawJson) {
  const response = await fetch(getSupabaseUrl() + '/functions/v1/process-intake', {
    method: 'POST',
    headers: supabaseAuthHeaders(),
    body: JSON.stringify({ raw_json: rawJson, user_id: runtimeConfig?.userId || null })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload && payload.error ? payload.error : ('HTTP ' + response.status));
  }
  return payload;
}

async function markOnboardingComplete() {
  const response = await fetch(getSupabaseUrl() + '/rest/v1/hearth_settings?on_conflict=key', {
    method: 'POST',
    headers: {
      ...supabaseAuthHeaders(),
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify({
      key: 'onboarding_complete',
      value: 'true'
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('Failed to skip onboarding: HTTP ' + response.status + (detail ? ' ' + detail : ''));
  }
}

async function handleIntakeUpload() {
  if (!intakeFileInputEl || !intakeUploadBtnEl) return;
  var file = intakeFileInputEl.files && intakeFileInputEl.files[0];
  if (!file) {
    intakeProgressEl && (intakeProgressEl.textContent = 'Choose conversations.json first.');
    return;
  }
  if (!file.name.toLowerCase().endsWith('.json')) {
    intakeProgressEl && (intakeProgressEl.textContent = 'Please upload a .json file.');
    return;
  }

  intakeUploadBtnEl.disabled = true;
  if (intakeResultEl) intakeResultEl.textContent = '';

  try {
    var rawJson = await file.text();
    var totalBatches = estimateBatchCount(rawJson);
    var currentBatch = 1;
    if (intakeProgressEl) intakeProgressEl.textContent = 'Reading your history... (batch 1 of ' + totalBatches + ')';
    var progressTimer = setInterval(function() {
      currentBatch = Math.min(totalBatches, currentBatch + 1);
      if (intakeProgressEl) intakeProgressEl.textContent = 'Reading your history... (batch ' + currentBatch + ' of ' + totalBatches + ')';
    }, 1500);

    var result;
    try {
      result = await processIntakeFile(rawJson);
    } finally {
      clearInterval(progressTimer);
    }

    var memoriesWritten = Number(result && result.memories_written || 0);
    if (intakeProgressEl) intakeProgressEl.textContent = '';
    if (intakeResultEl) intakeResultEl.textContent = 'Imported. ' + memoriesWritten + ' memories written.';
    setTimeout(function() {
      setIntakeMode(false);
      initNormalPopup();
    }, 600);
  } catch (err) {
    if (intakeProgressEl) intakeProgressEl.textContent = '';
    if (intakeResultEl) intakeResultEl.textContent = 'Import failed: ' + (err?.message || String(err));
  } finally {
    intakeUploadBtnEl.disabled = false;
  }
}

async function handleIntakeSkip() {
  if (!intakeSkipBtnEl) return;
  intakeSkipBtnEl.disabled = true;
  if (intakeUploadBtnEl) intakeUploadBtnEl.disabled = true;
  if (intakeResultEl) intakeResultEl.textContent = '';
  if (intakeProgressEl) intakeProgressEl.textContent = 'Skipping intake...';
  try {
    await markOnboardingComplete();
    if (intakeProgressEl) intakeProgressEl.textContent = '';
    setIntakeMode(false);
    initNormalPopup();
  } catch (err) {
    if (intakeProgressEl) intakeProgressEl.textContent = '';
    if (intakeResultEl) intakeResultEl.textContent = err?.message || String(err);
  } finally {
    intakeSkipBtnEl.disabled = false;
    if (intakeUploadBtnEl) intakeUploadBtnEl.disabled = false;
  }
}

async function refreshPrimeDirective() {
  try {
    const state = await fetchPrimeDirective();
    renderDirectiveState(state.primeDirective, state.directiveSetAt);
  } catch (err) {
    console.warn('[Presence] Failed to load directive:', err?.message || err);
    renderDirectiveState(null, null);
  }
}

async function submitDirective() {
  if (!directiveInputEl) return;
  const value = directiveInputEl.value.trim();
  if (!value) return;

  if (directiveSubmitBtn) directiveSubmitBtn.disabled = true;
  try {
    await setPrimeDirective(value);
    await refreshPrimeDirective();
  } catch (err) {
    showMessage('Directive update failed: ' + (err?.message || String(err)));
  } finally {
    if (directiveSubmitBtn) directiveSubmitBtn.disabled = false;
  }
}

async function clearDirective() {
  if (directiveClearBtn) directiveClearBtn.disabled = true;
  try {
    await setPrimeDirective(null);
    await refreshPrimeDirective();
  } catch (err) {
    showMessage('Directive clear failed: ' + (err?.message || String(err)));
  } finally {
    if (directiveClearBtn) directiveClearBtn.disabled = false;
  }
}

function renderPresenceReadyState() {
  var container = document.getElementById('output-feed');
  if (!container) return;

  var existing = container.querySelector('.presence-empty-state');
  var hasPresenceCards = !!container.querySelector('.presence-notification');

  if (hasPresenceCards) {
    if (existing) existing.remove();
    return;
  }

  if (!existing) {
    var ready = document.createElement('div');
    ready.className = 'presence-empty-state';
    ready.textContent = 'No pending presence notifications.';
    ready.style.cssText = 'padding:10px 12px; color:#999; font-size:12px; border:1px dashed #2f2f2f; border-radius:8px; margin-bottom:8px;';
    container.prepend(ready);
  }
}

function removePresenceNotificationById(notificationId) {
  var id = String(notificationId);
  dismissedPresenceNotificationIds.add(id);
  displayedPresenceNotifications = displayedPresenceNotifications.filter(function(n) {
    return String(n && n.id) !== id;
  });

  var container = document.getElementById('output-feed');
  if (!container) return;
  var el = container.querySelector('[data-id="' + id + '"]');
  if (!el) {
    renderPresenceReadyState();
    return;
  }
  el.classList.add('fade-out');
  setTimeout(function() {
    el.remove();
    renderPresenceReadyState();
  }, 300);
}

function timeAgo(date) {
  var seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

function buildReasoningBlock(reasoning) {
  if (!reasoning) return '';
  return '<div class="presence-reasoning notification-reasoning">' +
    '<div class="presence-reasoning-label">Why it fired:</div>' +
    String(reasoning).replace(/</g, '&lt;') +
    '</div>';
}

function buildGradeSummary(notification) {
  var parts = [];
  if (typeof notification.grade_timing === 'boolean') parts.push('Timing: ' + (notification.grade_timing ? 'Yes' : 'No'));
  if (notification.grade_insight) parts.push('Insight: ' + notification.grade_insight);
  if (typeof notification.grade_clarity === 'boolean') parts.push('Clarity: ' + (notification.grade_clarity ? 'Yes' : 'No'));
  return parts.length > 0 ? parts.join(' · ') : 'Graded';
}

function renderPendingActionNotification(notification) {
  var container = document.getElementById('output-feed');
  if (!container) return;
  if (container.querySelector('[data-id="' + notification.id + '"]')) return;

  var triggerCtx = {};
  try { triggerCtx = JSON.parse(notification.trigger_context || '{}'); } catch (_) {}
  var pendingActionId = triggerCtx.pending_action_id || '';
  var task = triggerCtx.task || notification.message || '';
  var mode = triggerCtx.mode || '';
  var reasoning = notification.trigger_signal_excerpt || '';
  var truncatedTask = task.length > 80 ? task.slice(0, 80) + '\u2026' : task;
  var ago = timeAgo(new Date(notification.created_at));

  var el = document.createElement('div');
  el.className = 'presence-notification';
  el.dataset.id = notification.id;

  el.innerHTML =
    '<div class="presence-header">' +
    '<span class="presence-type" style="color:#fbbf24;">\u23f8 Agent held</span>' +
    (mode ? '<span style="font-size:11px;color:#777;">' + mode + '</span>' : '') +
    '<span class="presence-time">' + ago + '</span>' +
    '</div>' +
    '<div class="pa-task">' + truncatedTask.replace(/</g, '&lt;') + '</div>' +
    (reasoning ? '<div class="pa-reasoning">' + reasoning.replace(/</g, '&lt;') + '</div>' : '') +
    '<div class="presence-expand-row">' +
    '<button class="presence-expand-btn pa-expand-draft" type="button">Show draft</button>' +
    '<span class="presence-expand-loading"></span>' +
    '</div>' +
    '<div class="pa-draft-body pa-draft-hidden"></div>' +
    '<div class="pa-action-row pa-draft-hidden">' +
    '<button class="pa-btn pa-btn-send pa-send-btn">Send as-is</button>' +
    '<button class="pa-btn pa-edit-toggle-btn">Edit</button>' +
    '<button class="pa-btn pa-btn-decline pa-decline-btn">Decline</button>' +
    '</div>' +
    '<div class="pa-edit-section pa-draft-hidden">' +
    '<textarea class="pa-edit-area"></textarea>' +
    '<div class="pa-action-row">' +
    '<button class="pa-btn pa-btn-send pa-send-edited-btn">Send edited</button>' +
    '<button class="pa-btn pa-cancel-edit-btn">Cancel</button>' +
    '</div>' +
    '</div>' +
    '<div class="pa-result-slot"></div>' +
    '<div class="presence-actions"><button class="dismiss-btn" title="Dismiss">\u2715</button></div>';

  var expandBtn = el.querySelector('.pa-expand-draft');
  var expandLoading = el.querySelector('.presence-expand-loading');
  var draftBody = el.querySelector('.pa-draft-body');
  var actionRow = el.querySelector('.pa-action-row');
  var editSection = el.querySelector('.pa-edit-section');
  var editArea = el.querySelector('.pa-edit-area');
  var sendBtn = el.querySelector('.pa-send-btn');
  var editToggleBtn = el.querySelector('.pa-edit-toggle-btn');
  var declineBtn = el.querySelector('.pa-decline-btn');
  var sendEditedBtn = el.querySelector('.pa-send-edited-btn');
  var cancelEditBtn = el.querySelector('.pa-cancel-edit-btn');
  var resultSlot = el.querySelector('.pa-result-slot');
  var draftExpanded = false;
  var draftContent = '';

  function patchPendingAction(patch) {
    return fetch(
      getSupabaseUrl() + '/rest/v1/pending_actions?id=eq.' + pendingActionId,
      {
        method: 'PATCH',
        headers: { ...supabaseAuthHeaders(), 'Prefer': 'return=minimal' },
        body: JSON.stringify(patch)
      }
    );
  }

  function markDone(label) {
    // Mark notification read and remove
    fetch(
      getSupabaseUrl() + '/rest/v1/presence_notifications?id=eq.' + notification.id,
      {
        method: 'PATCH',
        headers: { ...supabaseAuthHeaders(), 'Prefer': 'return=minimal' },
        body: JSON.stringify({ read: true })
      }
    ).catch(function() {});
    resultSlot.innerHTML = '<span class="pa-result">' + label + '</span>';
    setTimeout(function() { removePresenceNotificationById(notification.id); }, 800);
  }

  function disableAllButtons() {
    el.querySelectorAll('.pa-btn, .pa-expand-draft').forEach(function(b) { b.disabled = true; });
  }

  // Expand / collapse draft
  expandBtn.addEventListener('click', async function() {
    if (draftExpanded) {
      draftBody.classList.add('pa-draft-hidden');
      actionRow.classList.add('pa-draft-hidden');
      editSection.classList.add('pa-draft-hidden');
      expandBtn.textContent = 'Show draft';
      draftExpanded = false;
      return;
    }

    if (draftContent) {
      draftBody.textContent = draftContent;
      draftBody.classList.remove('pa-draft-hidden');
      actionRow.classList.remove('pa-draft-hidden');
      expandBtn.textContent = 'Hide draft';
      draftExpanded = true;
      return;
    }

    expandBtn.disabled = true;
    expandLoading.textContent = 'Loading...';
    try {
      var resp = await fetch(
        getSupabaseUrl() + '/rest/v1/pending_actions?id=eq.' + pendingActionId + '&select=action_payload&limit=1',
        { headers: supabaseAuthHeaders() }
      );
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var rows = await resp.json();
      var payload = rows && rows[0] ? rows[0].action_payload : null;
      if (payload && typeof payload === 'object') {
        draftContent = String(payload.agent_result || JSON.stringify(payload, null, 2));
      } else {
        draftContent = String(payload || '(no draft content)');
      }
      draftBody.textContent = draftContent;
      draftBody.classList.remove('pa-draft-hidden');
      actionRow.classList.remove('pa-draft-hidden');
      expandBtn.textContent = 'Hide draft';
      draftExpanded = true;
    } catch (err) {
      showMessage('Failed to load draft: ' + (err.message || String(err)));
    } finally {
      expandBtn.disabled = false;
      expandLoading.textContent = '';
    }
  });

  // Send as-is
  sendBtn.addEventListener('click', async function() {
    disableAllButtons();
    try {
      await patchPendingAction({ outcome: 'confirmed', consumed: true });
      markDone('Sent as-is');
    } catch (err) {
      showMessage('Send failed: ' + (err.message || String(err)));
    }
  });

  // Edit toggle
  editToggleBtn.addEventListener('click', function() {
    editArea.value = draftContent;
    actionRow.classList.add('pa-draft-hidden');
    editSection.classList.remove('pa-draft-hidden');
    editArea.focus();
  });

  // Cancel edit
  cancelEditBtn.addEventListener('click', function() {
    editSection.classList.add('pa-draft-hidden');
    actionRow.classList.remove('pa-draft-hidden');
  });

  // Send edited
  sendEditedBtn.addEventListener('click', async function() {
    var edited = editArea.value.trim();
    if (!edited) return;
    disableAllButtons();
    try {
      await patchPendingAction({
        outcome: 'edited',
        consumed: true,
        edited_payload: { result: edited }
      });
      markDone('Sent (edited)');
    } catch (err) {
      showMessage('Send edited failed: ' + (err.message || String(err)));
    }
  });

  // Decline
  declineBtn.addEventListener('click', async function() {
    disableAllButtons();
    try {
      await patchPendingAction({ outcome: 'declined', consumed: true });
      markDone('Declined');
    } catch (err) {
      showMessage('Decline failed: ' + (err.message || String(err)));
    }
  });

  // Dismiss
  var dismissBtn = el.querySelector('.dismiss-btn');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', function() {
      chrome.runtime.sendMessage({ type: 'MARK_NOTIFICATION_READ', notificationId: notification.id });
      removePresenceNotificationById(notification.id);
    });
  }

  chrome.runtime.sendMessage({ type: 'MARK_NOTIFICATION_READ', notificationId: notification.id });
  container.prepend(el);
  hideNotificationReasoning();
  renderPresenceReadyState();
}

function hideNotificationReasoning() {
  document.querySelectorAll('.notification-reasoning').forEach(el => {
    el.style.display = 'none';
  });
}

function renderPresenceNotification(notification) {
  // Route pending_action notifications to dedicated renderer
  if (notification.trigger_type === 'pending_action') {
    return renderPendingActionNotification(notification);
  }

  var container = document.getElementById('output-feed');
  if (!container) return;
  if (container.querySelector('[data-id="' + notification.id + '"]')) return;

  var alreadyGraded = Boolean(notification.graded_at);

  var el = document.createElement('div');
  el.className = 'presence-notification';
  el.dataset.id = notification.id;

  var confidence = notification.oracle_confidence;
  var confidenceColor = confidence >= 0.7 ? '#4ade80' : confidence >= 0.4 ? '#fbbf24' : '#f87171';
  var labels = { state_change: 'State Change', email_trigger: 'Reply', scout_alert: 'Scout Alert', manual: 'Manual', pending_action: 'Agent Held' };
  var ago = timeAgo(new Date(notification.created_at));

  var headerHtml = '<div class="presence-header">' +
    '<span class="presence-type">' + (labels[notification.trigger_type] || notification.trigger_type) + '</span>' +
    (confidence ? '<span class="presence-confidence" style="color:' + confidenceColor + '">' + Math.round(confidence * 100) + '%</span>' : '') +
    '<span class="presence-time">' + ago + '</span></div>' +
    '<div class="presence-message">' + notification.message.replace(/</g, '&lt;') + '</div>';

  var expandHtml = '<div class="presence-expand-row">' +
    '<button class="presence-expand-btn" type="button">Expand</button>' +
    '<span class="presence-expand-loading"></span>' +
    '</div>' +
    '<div class="presence-expand-body presence-expand-hidden"></div>';

  if (alreadyGraded) {
    // Already graded: show summary + reasoning immediately, no grade UI
    el.innerHTML = headerHtml + expandHtml +
      '<div class="grade-summary">' + buildGradeSummary(notification) + '</div>' +
      buildReasoningBlock(notification.reasoning) +
      '<div class="presence-actions"><button class="dismiss-btn" title="Dismiss">✕</button></div>';
  } else {
    // Build three micro-rating rows
    el.innerHTML = headerHtml + expandHtml +
      '<div class="presence-actions">' +
      '<div class="grade-rows">' +
      '<div class="grade-row">' +
      '<span class="grade-row-label">Right time?</span>' +
      '<div class="grade-row-options">' +
      '<button class="grade-opt-btn" data-field="grade_timing" data-value="true">Yes</button>' +
      '<button class="grade-opt-btn" data-field="grade_timing" data-value="false">No</button>' +
      '</div></div>' +
      '<div class="grade-row">' +
      '<span class="grade-row-label">Real insight?</span>' +
      '<div class="grade-row-options">' +
      '<button class="grade-opt-btn" data-field="grade_insight" data-value="yes">Yes</button>' +
      '<button class="grade-opt-btn" data-field="grade_insight" data-value="partial">Partial</button>' +
      '<button class="grade-opt-btn" data-field="grade_insight" data-value="no">No</button>' +
      '</div></div>' +
      '<div class="grade-row">' +
      '<span class="grade-row-label">Clear enough?</span>' +
      '<div class="grade-row-options">' +
      '<button class="grade-opt-btn" data-field="grade_clarity" data-value="true">Yes</button>' +
      '<button class="grade-opt-btn" data-field="grade_clarity" data-value="false">No</button>' +
      '</div></div>' +
      '<button class="grade-submit-btn" disabled>Submit</button>' +
      '</div>' +
      '<button class="dismiss-btn" title="Dismiss">✕</button>' +
      '</div>' +
      '<div class="presence-reasoning-slot"></div>';
  }

  // -- Expand button logic --
  var expandBtn = el.querySelector('.presence-expand-btn');
  var expandLoading = el.querySelector('.presence-expand-loading');
  var expandBody = el.querySelector('.presence-expand-body');
  var expandTextCache = '';
  var expandOpen = false;

  function setExpandUi() {
    if (!expandBtn || !expandBody) return;
    expandBtn.textContent = expandOpen ? 'Collapse' : 'Expand';
    expandBody.classList.toggle('presence-expand-hidden', !expandOpen);
  }

  function extractConverseText(payload) {
    if (!payload) return '';
    if (typeof payload === 'string') return payload.trim();
    if (typeof payload.response === 'string') return payload.response.trim();
    if (typeof payload.message === 'string') return payload.message.trim();
    if (typeof payload.text === 'string') return payload.text.trim();
    if (payload.data && typeof payload.data.response === 'string') return payload.data.response.trim();
    if (Array.isArray(payload.content) && payload.content[0] && typeof payload.content[0].text === 'string') {
      return payload.content[0].text.trim();
    }
    return '';
  }

  async function expandBreadcrumb() {
    if (!expandBtn || !expandBody || !expandLoading) return;
    if (expandOpen) {
      expandOpen = false;
      setExpandUi();
      return;
    }

    if (expandTextCache) {
      expandBody.textContent = expandTextCache;
      expandOpen = true;
      setExpandUi();
      return;
    }

    expandBtn.disabled = true;
    expandLoading.textContent = 'Loading...';
    try {
      const response = await fetch(getSupabaseUrl() + '/functions/v1/presence-converse', {
        method: 'POST',
        headers: supabaseAuthHeaders(),
        body: JSON.stringify({
          question: 'Explain this breadcrumb in 2-3 paragraphs — what pattern you saw, why it was worth surfacing, and what connection you made. Be specific. Breadcrumb: ' + notification.message
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error((payload && payload.error) || ('HTTP ' + response.status));
      }
      const expanded = extractConverseText(payload);
      if (!expanded) {
        throw new Error('No expansion text returned');
      }
      expandTextCache = expanded;
      expandBody.textContent = expandTextCache;
      expandOpen = true;
      setExpandUi();
    } catch (err) {
      showMessage('Expand failed: ' + (err?.message || String(err)));
    } finally {
      expandBtn.disabled = false;
      expandLoading.textContent = '';
    }
  }

  if (expandBtn) {
    expandBtn.addEventListener('click', expandBreadcrumb);
  }

  // -- Dismiss button --
  var dismissBtn = el.querySelector('.dismiss-btn');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', function() {
      chrome.runtime.sendMessage({ type: 'MARK_NOTIFICATION_READ', notificationId: notification.id });
      removePresenceNotificationById(notification.id);
    });
  }

  // -- Three-dimensional grading logic (only if not already graded) --
  if (!alreadyGraded) {
    var gradeState = { grade_timing: null, grade_insight: null, grade_clarity: null };
    var submitBtn = el.querySelector('.grade-submit-btn');

    function checkGradeComplete() {
      var complete = gradeState.grade_timing !== null &&
                     gradeState.grade_insight !== null &&
                     gradeState.grade_clarity !== null;
      if (submitBtn) submitBtn.disabled = !complete;
    }

    el.querySelectorAll('.grade-opt-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var field = btn.dataset.field;
        var value = btn.dataset.value;

        // Deselect siblings
        var siblings = btn.closest('.grade-row-options').querySelectorAll('.grade-opt-btn');
        siblings.forEach(function(s) { s.classList.remove('selected'); });
        btn.classList.add('selected');

        // Store value
        if (field === 'grade_timing' || field === 'grade_clarity') {
          gradeState[field] = value === 'true';
        } else {
          gradeState[field] = value;
        }
        checkGradeComplete();
      });
    });

    if (submitBtn) {
      submitBtn.addEventListener('click', function() {
        if (gradeState.grade_timing === null || gradeState.grade_insight === null || gradeState.grade_clarity === null) return;

        // Compute legacy outcome
        var outcome;
        if (gradeState.grade_timing && gradeState.grade_insight === 'yes' && gradeState.grade_clarity) {
          outcome = 'E';
        } else if (gradeState.grade_insight === 'no') {
          outcome = 'D';
        } else {
          outcome = 'G';
        }

        var gradeFields = {
          grade_timing: gradeState.grade_timing,
          grade_insight: gradeState.grade_insight,
          grade_clarity: gradeState.grade_clarity,
          graded_at: new Date().toISOString()
        };

        chrome.runtime.sendMessage({
          type: 'SCORE_NOTIFICATION',
          notificationId: notification.id,
          outcome: outcome,
          gradeFields: gradeFields
        });

        // Replace grade rows with summary
        var actionsEl = el.querySelector('.presence-actions');
        if (actionsEl) {
          actionsEl.innerHTML = '<span class="score-result">Graded: ' + outcome + '</span>';
        }

        // Reveal reasoning
        var slot = el.querySelector('.presence-reasoning-slot');
        if (slot && notification.reasoning) {
          slot.innerHTML = buildReasoningBlock(notification.reasoning);
        }
      });
    }
  }

  chrome.runtime.sendMessage({ type: 'MARK_NOTIFICATION_READ', notificationId: notification.id });
  container.prepend(el);
  hideNotificationReasoning();
  renderPresenceReadyState();
}

function mergePresenceNotifications(incoming) {
  var list = Array.isArray(incoming) ? incoming : [];
  var byId = new Map(displayedPresenceNotifications.map(function(n) {
    return [String(n.id), n];
  }));
  var added = [];

  list.forEach(function(notification) {
    var id = String(notification && notification.id);
    if (!id || dismissedPresenceNotificationIds.has(id) || byId.has(id)) return;
    byId.set(id, notification);
    displayedPresenceNotifications.push(notification);
    added.push(notification);
  });

  return added;
}

// Listen for presence notifications
chrome.runtime.onMessage.addListener(function(msg) {
  if (msg.type === 'PRESENCE_NOTIFICATIONS') {
    var newlyAdded = mergePresenceNotifications(msg.notifications || []);
    newlyAdded.forEach(renderPresenceNotification);
    hideNotificationReasoning();
    renderPresenceReadyState();
  }
});

const realtimeToggleBtn = document.getElementById('realtime-toggle-btn');
const realtimeStatusDot = document.getElementById('realtime-status-dot');
const realtimeStatusText = document.getElementById('realtime-status-text');
const watchFolderBtn = document.getElementById('watch-folder-btn');
const watchFolderStatusEl = document.getElementById('watch-folder-status');
let activeWatchedFolder = '';
let activeWatchTargetType = null;

function setRealtimeToggleUi(active) {
  if (!realtimeToggleBtn || !realtimeStatusDot || !realtimeStatusText) return;
  realtimeToggleBtn.classList.toggle('active', active);
  realtimeStatusDot.classList.toggle('active', active);
  realtimeStatusText.textContent = active ? 'recording' : 'off';
  realtimeStatusText.style.color = active ? '#ef4444' : '#777';
}

function truncateFolderPath(path) {
  var value = String(path || '').trim();
  if (value.length <= 30) return value;
  return value.slice(0, 27) + '...';
}

function setWatchFolderUi(targetPath, targetType) {
  activeWatchedFolder = String(targetPath || '').trim();
  activeWatchTargetType = targetType || null;

  if (watchFolderBtn) {
    if (activeWatchedFolder) {
      var parts = activeWatchedFolder.split(/[\/]/).filter(Boolean);
      var name = parts.length ? parts[parts.length - 1] : activeWatchedFolder;
      watchFolderBtn.textContent = 'Stop Watching ' + truncateFolderPath(name);
    } else {
      watchFolderBtn.textContent = 'Watch';
    }
  }

  if (!watchFolderStatusEl) return;

  if (!activeWatchedFolder) {
    watchFolderStatusEl.textContent = 'No target selected.';
    return;
  }

  var typeLabel = activeWatchTargetType === 'file' || activeWatchTargetType === 'folder'
    ? activeWatchTargetType
    : 'unknown';

  watchFolderStatusEl.innerHTML =
    '<span class="watch-folder-type" style="font-size:10px;color:#888;text-transform:uppercase;margin-right:6px;">' +
    typeLabel.replace(/</g, '&lt;') +
    '</span>' +
    '<span class="watch-folder-path">' + truncateFolderPath(activeWatchedFolder).replace(/</g, '&lt;') + '</span>';
}

async function refreshWatchFolderStatus() {

  if (!watchFolderStatusEl) return;
  try {
    var response = await fetch('http://localhost:5556/status');
    if (!response.ok) {
      // Backward compatibility with older daemon builds that only expose /health.
      response = await fetch('http://localhost:5556/health');
    }
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    var payload = await response.json();
    var watching = Boolean(payload && payload.watching);
    var target = payload?.target || payload?.watched_file || payload?.watched_folder || payload?.watch_folder || payload?.watchFolder || payload?.folder || '';
    var targetType = payload?.target_type || (payload?.watched_file ? 'file' : (payload?.watched_folder ? 'folder' : null));
    setWatchFolderUi(watching ? target : '', watching ? targetType : null);
  } catch (err) {
    console.warn('[Presence] Failed to load watch folder status:', err?.message || err);
    setWatchFolderUi('', null);
  }
}

async function toggleWatchFolder() {
  if (!watchFolderBtn) return;

  const endpoint = activeWatchedFolder ? 'http://localhost:5556/stop-watching' : 'http://localhost:5556/pick-target';
  const originalLabel = watchFolderBtn.textContent;
  watchFolderBtn.disabled = true;
  watchFolderBtn.textContent = activeWatchedFolder ? 'Stopping...' : 'Choosing...';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: runtimeConfig?.userId || null }),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = payload?.reason ? ` (${payload.reason})` : '';
      throw new Error((payload?.error || ('HTTP ' + response.status)) + reason);
    }
    if (payload?.ok === false) {
      throw new Error(payload?.error || 'Folder picker failed');
    }
    await refreshWatchFolderStatus();
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    showMessage(aborted
      ? 'Watch failed: request timed out. Check macOS picker permissions and try again.'
      : 'Watch failed: ' + (err?.message || String(err))
    );
  } finally {
    clearTimeout(timeoutId);
    watchFolderBtn.disabled = false;
    if (!activeWatchedFolder) {
      watchFolderBtn.textContent = originalLabel || 'Watch';
    }
  }
}

async function refreshRealtimeToggle() {
  if (!realtimeToggleBtn) return;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_REALTIME_ACTIVE' });
    if (result && result.success) {
      setRealtimeToggleUi(Boolean(result.active));
    } else {
      console.warn('[UD] Failed to read realtime toggle state:', result && result.error);
    }
  } catch (err) {
    console.warn('[UD] Failed to refresh realtime toggle:', err);
  }
}

async function toggleRealtimeActive() {
  if (!realtimeToggleBtn) return;
  const nextActive = !realtimeToggleBtn.classList.contains('active');
  realtimeToggleBtn.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'SET_REALTIME_ACTIVE', active: nextActive });
    if (result && result.success) {
      setRealtimeToggleUi(Boolean(result.active));
    } else {
      console.warn('[UD] Realtime toggle update failed:', result && result.error);
      showMessage('Realtime toggle failed: ' + ((result && result.error) || 'unknown error'));
    }
  } catch (err) {
    console.warn('[UD] Realtime toggle error:', err);
    showMessage('Realtime toggle error: ' + (err?.message || String(err)));
  } finally {
    realtimeToggleBtn.disabled = false;
  }
}

if (realtimeToggleBtn) {
  realtimeToggleBtn.addEventListener('click', toggleRealtimeActive);
}
if (watchFolderBtn) {
  watchFolderBtn.addEventListener('click', toggleWatchFolder);
}

if (directiveSubmitBtn) {
  directiveSubmitBtn.addEventListener('click', submitDirective);
}
if (directiveInputEl) {
  directiveInputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitDirective();
    }
  });
}
if (directiveUpdateBtn) {
  directiveUpdateBtn.addEventListener('click', () => {
    if (directiveEditorEl) directiveEditorEl.classList.remove('directive-hidden');
    if (directiveInputEl && directiveTextEl) {
      directiveInputEl.value = directiveTextEl.textContent || '';
      directiveInputEl.focus();
      directiveInputEl.select();
    }
    if (directiveSubmitBtn) directiveSubmitBtn.textContent = 'Update';
  });
}
if (directiveClearBtn) {
  directiveClearBtn.addEventListener('click', clearDirective);
}

function initNormalPopup() {
  if (normalPopupInitialized) return;
  normalPopupInitialized = true;
  setSetupMode(false);
  setIntakeMode(false);
  refreshRealtimeToggle();
  refreshWatchFolderStatus();
  refreshPrimeDirective();

  chrome.storage.session.get('presenceNotifications', function(data) {
    var seeded = mergePresenceNotifications(data.presenceNotifications || []);
    seeded.forEach(renderPresenceNotification);
    hideNotificationReasoning();
    renderPresenceReadyState();
  });
}

async function saveSetupConfiguration() {
  const url = String(setupUrlInputEl?.value || '').trim().replace(/\/+$/, '');
  const anonKey = String(setupAnonKeyInputEl?.value || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Enter a valid Supabase URL.');
  }
  if (!anonKey) {
    throw new Error('Supabase anon key is required.');
  }
  const existing = await chrome.storage.local.get(USER_ID_STORAGE_KEY);
  const userId = String(existing[USER_ID_STORAGE_KEY] || '') || crypto.randomUUID();
  await chrome.storage.local.set({
    [SUPABASE_URL_STORAGE_KEY]: url,
    [SUPABASE_ANON_KEY_STORAGE_KEY]: anonKey,
    [USER_ID_STORAGE_KEY]: userId,
    [SETUP_COMPLETE_STORAGE_KEY]: true
  });
  runtimeConfig = {
    url,
    anonKey,
    userId,
    setupComplete: true
  };
}

async function handleSetupContinue() {
  if (!setupContinueBtnEl) return;
  setupContinueBtnEl.disabled = true;
  if (setupErrorEl) setupErrorEl.textContent = '';
  try {
    await saveSetupConfiguration();
    await bootOnboardingGate();
  } catch (err) {
    if (setupErrorEl) setupErrorEl.textContent = err?.message || String(err);
  } finally {
    setupContinueBtnEl.disabled = false;
  }
}

async function bootOnboardingGate() {
  try {
    await loadRuntimeConfig();
    updateStatusBar();
    setInterval(updateStatusBar, 15000);
    if (!isConfigReady()) {
      setSetupMode(true);
      return;
    }

    var onboardingComplete = await hasOnboardingComplete();
    var needsIntake = !onboardingComplete;
    setIntakeMode(needsIntake);
    if (needsIntake) return;
  } catch (err) {
    console.warn('[Presence] Intake gate check failed:', err?.message || err);
    setSetupMode(false);
    setIntakeMode(false);
  }
  initNormalPopup();
}

if (intakeUploadBtnEl) {
  intakeUploadBtnEl.addEventListener('click', handleIntakeUpload);
}
if (intakeSkipBtnEl) {
  intakeSkipBtnEl.addEventListener('click', handleIntakeSkip);
}
if (setupContinueBtnEl) {
  setupContinueBtnEl.addEventListener('click', handleSetupContinue);
}
if (setupUrlInputEl) {
  setupUrlInputEl.addEventListener('keydown', function(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleSetupContinue();
    }
  });
}
if (setupAnonKeyInputEl) {
  setupAnonKeyInputEl.addEventListener('keydown', function(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleSetupContinue();
    }
  });
}

chrome.runtime.sendMessage({ type: 'POPUP_OPENED' }).catch(() => {});
bootOnboardingGate();
