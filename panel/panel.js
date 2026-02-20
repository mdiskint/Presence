// ============================================================
// INJECT PANEL AS FLOATING IFRAME
// Runs in content script context — injects the panel UI
// into every page as a floating, draggable iframe.
// ============================================================

if (!window.__udPanelInjected && window.parent === window) {
  window.__udPanelInjected = true;

  const iframe = document.createElement('iframe');
  iframe.src = chrome.runtime.getURL('panel/panel.html');
  iframe.id = '__ud-panel';

  Object.assign(iframe.style, {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    width: '360px',
    height: '120px',
    border: 'none',
    borderRadius: '10px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    zIndex: '2147483647',
    resize: 'both',
    overflow: 'auto',
    minWidth: '280px',
    minHeight: '80px',
    maxWidth: '600px',
    maxHeight: '500px'
  });

  document.body.appendChild(iframe);

  // ── Drag to move ──
  let dragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  // Listen for drag events from inside the iframe
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'UD_DRAG_START') {
      dragging = true;
      const rect = iframe.getBoundingClientRect();
      dragOffsetX = e.data.x - rect.left;
      dragOffsetY = e.data.y - rect.top;
      iframe.style.right = 'auto';
      iframe.style.bottom = 'auto';
    }
    if (e.data?.type === 'UD_DRAG_END') {
      dragging = false;
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    iframe.style.left = (e.clientX - dragOffsetX) + 'px';
    iframe.style.top  = (e.clientY - dragOffsetY) + 'px';
  });

  document.addEventListener('mouseup', () => {
    dragging = false;
  });
}

// ============================================================
// UPSIDE DOWN — panel/panel.js
// The Shell: handles UI state, sends messages to background.js
// ============================================================

const statusBar      = document.getElementById('status-bar');
const messageDisplay = document.getElementById('message-display');
const taskInput      = document.getElementById('task-input');
const sendBtn        = document.getElementById('send-btn');
const approvalPanel  = document.getElementById('approval-panel');
const declineNote    = document.getElementById('decline-note');
const approveBtn     = document.getElementById('approve-btn');
const declineBtn     = document.getElementById('decline-btn');
const apiKeySection  = document.getElementById('api-key-section');
const apiKeyInput    = document.getElementById('api-key-input');
const saveKeyBtn     = document.getElementById('save-key-btn');
const statusText     = document.getElementById('status-text');
const settingsToggle = document.getElementById('settings-toggle');

// ============================================================
// UI STATE
// ============================================================

function setStatus(status, message) {
  // Status bar color
  statusBar.className = '';
  if (status === 'working')           statusBar.classList.add('working');
  if (status === 'awaiting_approval') statusBar.classList.add('approval');

  // Status text
  const labels = {
    idle: 'idle',
    working: 'working...',
    awaiting_approval: 'ready for approval'
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
    sendBtn.disabled = true;
  } else {
    approvalPanel.classList.remove('visible');
    sendBtn.disabled = false;
    declineNote.value = '';
  }
}

function showMessage(text) {
  messageDisplay.textContent = text;
  messageDisplay.classList.add('visible');
}

// ============================================================
// SEND TASK
// ============================================================

async function sendTask() {
  const text = taskInput.value.trim();
  if (!text) return;

  taskInput.value = '';
  setStatus('working');
  showMessage('Working...');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'USER_MESSAGE',
      text
    });

    if (response.error) {
      showMessage(`Error: ${response.error}`);
      setStatus('idle');
      return;
    }

    setStatus(response.status, response.message);

  } catch (err) {
    showMessage(`Error: ${err.message}`);
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
    } else {
      showMessage(response.message || 'Done.');
    }
    setStatus('idle');
  } catch (err) {
    showMessage(`Error: ${err.message}`);
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
      setStatus('idle');
      return;
    }

    setStatus(response.status, response.message);

  } catch (err) {
    showMessage(`Error: ${err.message}`);
    setStatus('idle');
  }
}

// ============================================================
// API KEY
// ============================================================

async function saveApiKey() {
  const key = apiKeyInput.value.trim();
  if (!key) return;

  await chrome.runtime.sendMessage({ type: 'SET_API_KEY', key });
  apiKeyInput.value = '';
  apiKeySection.classList.remove('visible');
  showMessage('API key saved.');
}

settingsToggle.addEventListener('click', () => {
  apiKeySection.classList.toggle('visible');
});

saveKeyBtn.addEventListener('click', saveApiKey);

// ============================================================
// EVENT LISTENERS
// ============================================================

sendBtn.addEventListener('click', sendTask);

taskInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendTask();
  }
});

approveBtn.addEventListener('click', approve);
declineBtn.addEventListener('click', decline);

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
dragHandle.addEventListener('mousedown', (e) => {
  window.parent.postMessage({
    type: 'UD_DRAG_START',
    x: e.screenX,
    y: e.screenY
  }, '*');
  e.preventDefault();
});
document.addEventListener('mouseup', () => {
  window.parent.postMessage({ type: 'UD_DRAG_END' }, '*');
});

window.addEventListener('message', (e) => {
  if (e.data?.type === 'UD_STATUS_UPDATE') {
    setStatus(e.data.status, e.data.message);
  }
});

init();
