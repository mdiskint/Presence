// ============================================================
// UPSIDE DOWN — content/content.js
// The Hands: executes actions on the current page.
// Knows nothing about Claude or missions.
// Receives action objects, executes them, reports back.
// ============================================================

// Double-injection guard
if (window.__udLoaded) {
  // already loaded, do nothing
} else {
  window.__udLoaded = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'EXECUTE_ACTION') {
      executeAction(message.action)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // keep channel open for async
    }

    if (message.type === 'UD_STATUS_UPDATE') {
      const iframe = document.getElementById('__ud-panel');
      if (iframe) {
        iframe.contentWindow.postMessage({
          type: 'UD_STATUS_UPDATE',
          status: message.status,
          message: message.message
        }, '*');
      }
    }

    if (message.type === 'GET_CONTEXT') {
      sendResponse({
        url: window.location.href,
        title: document.title,
        body: document.body.innerText.slice(0, 3000)
      });
    }
  });

  async function executeAction(action) {
    switch (action.type) {

      case 'fill': {
        const el = document.querySelector(action.selector);
        if (!el) return { success: false, error: `fill: selector not found: ${action.selector}` };

        // Use native setter — works on React-controlled inputs and textareas
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const nativeValueSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        nativeValueSetter.call(el, action.value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };
      }

      case 'click': {
        const el = document.querySelector(action.selector);
        if (!el) return { success: false, error: `click: selector not found: ${action.selector}` };

        // Use MouseEvent — works on React-controlled components
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return { success: true };
      }

      case 'scroll': {
        // action.selector = element to scroll inside (optional, defaults to window)
        // action.direction = 'down' | 'up'
        // action.amount = pixels (default 500)
        const amount = action.amount || 500;
        const direction = action.direction === 'up' ? -1 : 1;

        if (action.selector) {
          const el = document.querySelector(action.selector);
          if (!el) return { success: false, error: `scroll: selector not found: ${action.selector}` };
          el.scrollBy(0, direction * amount);
        } else {
          window.scrollBy(0, direction * amount);
        }
        return { success: true };
      }

      case 'navigate': {
        // navigate is disabled — system should use openTab instead
        return { success: false, error: 'navigate is disabled. Use openTab in background.js instead.' };
      }

      case 'read': {
        // Returns page context without taking any action
        return {
          success: true,
          url: window.location.href,
          title: document.title,
          body: document.body.innerText.slice(0, 3000)
        };
      }

      case 'key': {
        const el = action.selector
          ? document.querySelector(action.selector)
          : document.activeElement;
        if (!el) return { success: false, error: `key: selector not found: ${action.selector}` };

        const keyEvent = new KeyboardEvent('keydown', {
          key: action.value,
          code: action.value === 'Enter' ? 'Enter' : action.value,
          keyCode: action.value === 'Enter' ? 13 : 0,
          bubbles: true,
          cancelable: true
        });
        el.dispatchEvent(keyEvent);
        el.dispatchEvent(new KeyboardEvent('keyup', { key: action.value, bubbles: true }));

        // If Enter on a form element, also try submitting the form
        if (action.value === 'Enter' && el.form) {
          el.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }

        return { success: true };
      }

      default:
        return { success: false, error: `Unknown action type: ${action.type}` };
    }
  }
}
