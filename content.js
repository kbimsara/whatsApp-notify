/**
 * content.js — WhatsApp Web DOM Observer (v2 — Resilient)
 *
 * Content script that runs on https://web.whatsapp.com/*
 *
 * Rebuilt with broad, resilient selectors and a polling fallback
 * to handle WhatsApp Web DOM changes across versions.
 *
 * Strategy:
 *   1. MutationObserver on #main for real-time message detection
 *   2. Polling fallback every 2s to catch anything the observer misses
 *   3. Sidebar scanning for unread badges on trigger groups
 *   4. Multiple fallback selectors for every DOM query
 *   5. Console logging always enabled for critical events
 */

(() => {
  'use strict';

  // =========================================================================
  // State
  // =========================================================================

  let isReady = false;
  let monitoringEnabled = false;
  let triggerGroup = '';
  let stopGroup = '';
  let mainObserver = null;
  let sidebarObserver = null;
  let pollingInterval = null;
  const processedMessageIds = new Set();
  let devLogs = false;
  let lastKnownMessageCount = 0;

  // Maximum number of processed message IDs to retain
  const MAX_PROCESSED_IDS = 5000;
  const READY_DELAY = 3000;
  const POLL_INTERVAL = 2000;

  // =========================================================================
  // Logging — Critical events always log, debug events respect devLogs
  // =========================================================================

  function log(...args) {
    if (devLogs) {
      console.log('%c[WA-Alert]', 'color: #58a6ff; font-weight: bold', ...args);
    }
  }

  function logAlways(...args) {
    console.log('%c[WA-Alert]', 'color: #3fb950; font-weight: bold', ...args);
  }

  function logError(...args) {
    console.error('%c[WA-Alert]', 'color: #f85149; font-weight: bold', ...args);
  }

  // =========================================================================
  // DOM Query Helpers — Try multiple selectors, return first match
  // =========================================================================

  /**
   * Try multiple selectors and return the first match.
   */
  function queryFirst(parent, ...selectors) {
    for (const sel of selectors) {
      try {
        const el = parent.querySelector(sel);
        if (el) return el;
      } catch (e) { /* invalid selector, skip */ }
    }
    return null;
  }

  /**
   * Try multiple selectors and return all matches combined.
   */
  function queryAll(parent, ...selectors) {
    const results = [];
    const seen = new Set();
    for (const sel of selectors) {
      try {
        const els = parent.querySelectorAll(sel);
        for (const el of els) {
          if (!seen.has(el)) {
            seen.add(el);
            results.push(el);
          }
        }
      } catch (e) { /* invalid selector, skip */ }
    }
    return results;
  }

  // =========================================================================
  // Chat Name Detection — Get the currently open chat/group name
  // =========================================================================

  function getActiveChatName() {
    // Strategy 1: header span with title attribute
    const headerSpan = queryFirst(document,
      '#main header span[title]',
      '#main header [data-testid="conversation-info-header-chat-title"]',
      '#main header ._amig span',                   // Some WA Web versions
      '#main header [role="button"] span[title]',
      '#main header span[dir="auto"]'
    );
    if (headerSpan) {
      const title = headerSpan.getAttribute('title') || headerSpan.textContent;
      if (title && title.trim()) return title.trim();
    }

    // Strategy 2: look for the first prominent span in main header
    const mainHeader = document.querySelector('#main header');
    if (mainHeader) {
      const spans = mainHeader.querySelectorAll('span');
      for (const span of spans) {
        const text = span.textContent?.trim();
        // Skip very short texts (like status icons) and very long (descriptions)
        if (text && text.length > 1 && text.length < 100) {
          // Skip timestamps and common UI text
          if (!/^\d{1,2}:\d{2}/.test(text) && text !== 'click here' && text !== 'search') {
            return text;
          }
        }
      }
    }

    return '';
  }

  // =========================================================================
  // Message Container Detection
  // =========================================================================

  function findMessageContainer() {
    return queryFirst(document,
      // Most common: the scrollable message area
      '#main [role="application"]',
      '#main div.copyable-area',
      '#main [data-testid="conversation-panel-messages"]',
      '#main [data-testid="msg-container"]',
      // Generic fallback: main's largest scrollable div
      '#main div[tabindex="-1"]',
      '#main div[class*="message"]',
      // Ultimate fallback
      '#main'
    );
  }

  // =========================================================================
  // Message Element Detection
  // =========================================================================

  /**
   * Find all message elements in the current view.
   * Returns elements that represent individual chat messages.
   */
  function findAllMessages() {
    return queryAll(document,
      '#main .message-in',
      '#main .message-out',
      '#main [data-id^="true_"]',
      '#main [data-id^="false_"]',
      '#main div[data-id]',
      '#main [data-testid="msg-container"]',
      '#main [class*="message-in"]',
      '#main [class*="message-out"]'
    );
  }

  /**
   * Get a unique identifier for a message element.
   */
  function getMessageId(messageEl) {
    // Walk up to find data-id
    let el = messageEl;
    let depth = 0;
    while (el && depth < 10) {
      const dataId = el.getAttribute('data-id');
      if (dataId) return dataId;
      el = el.parentElement;
      depth++;
    }

    // Fallback: use text + position hash
    const text = getMessageText(messageEl);
    const timeEl = messageEl.querySelector('[data-testid="msg-time"], span[dir="auto"]');
    const time = timeEl?.textContent || '';
    const rect = messageEl.getBoundingClientRect();
    return `fb_${text}_${time}_${Math.round(rect.top)}`;
  }

  /**
   * Extract text content from a message element.
   */
  function getMessageText(messageEl) {
    // Try multiple strategies
    const textEl = queryFirst(messageEl,
      '.selectable-text span',
      '.copyable-text span',
      'span.selectable-text',
      'span[dir="ltr"]',
      'span[dir="rtl"]',
      'span[dir="auto"]',
      '[data-testid="balloon-text"] span'
    );

    if (textEl) {
      const text = textEl.textContent?.trim();
      if (text) return text;
    }

    // Fallback: get all text spans within the message
    const spans = messageEl.querySelectorAll('span');
    for (const span of spans) {
      const text = span.textContent?.trim();
      // Filter out timestamps, sender names etc — want the actual message
      if (text && text.length > 0 && text.length < 5000) {
        // Skip if it looks like a time (HH:MM)
        if (/^\d{1,2}:\d{2}\s*(AM|PM)?$/i.test(text)) continue;
        // Skip very short single chars
        if (text.length === 1) continue;
        return text;
      }
    }

    return '';
  }

  /**
   * Check if a message element is an outgoing (own) message.
   */
  function isOwnMessage(messageEl) {
    let el = messageEl;
    let depth = 0;
    while (el && depth < 10) {
      if (el.classList?.contains('message-out')) return true;
      if (el.className && typeof el.className === 'string' && el.className.includes('message-out')) return true;
      el = el.parentElement;
      depth++;
    }
    return false;
  }

  /**
   * Get sender name from a group message.
   */
  function getSenderName(messageEl) {
    // data-pre-plain-text attribute
    const preEl = messageEl.querySelector('[data-pre-plain-text]');
    if (preEl) {
      const attr = preEl.getAttribute('data-pre-plain-text');
      const match = attr?.match(/\]\s*(.+?):/);
      if (match) return match[1].trim();
    }

    // Sender name span (usually has aria-label or is a specific span)
    const senderEl = queryFirst(messageEl,
      'span[data-testid="msg-meta"]',
      'span[aria-label]',
      '[data-testid="author"]'
    );
    if (senderEl) {
      return senderEl.textContent?.trim() || 'Unknown';
    }

    return 'Unknown';
  }

  // =========================================================================
  // Message Processing
  // =========================================================================

  function processMessageElement(messageEl) {
    if (!isReady || !monitoringEnabled) return;

    const msgId = getMessageId(messageEl);
    if (!msgId || processedMessageIds.has(msgId)) return;

    // Mark as processed
    processedMessageIds.add(msgId);
    pruneProcessedIds();

    const group = getActiveChatName();
    if (!group) {
      log('No active chat name found, skipping');
      return;
    }

    const text = getMessageText(messageEl);
    const sender = getSenderName(messageEl);
    const ownMsg = isOwnMessage(messageEl);

    if (!text) return; // Skip non-text messages

    logAlways(`📩 Message in "${group}" from ${sender}: "${text.substring(0, 80)}" (own: ${ownMsg})`);

    // Send to background
    chrome.runtime.sendMessage({
      type: 'NEW_MESSAGE',
      data: {
        group,
        text,
        sender,
        isOwnMessage: ownMsg,
        messageId: msgId,
        timestamp: Date.now(),
        source: 'chat'
      }
    }).catch(err => {
      logError('Failed to send message to background:', err.message);
    });
  }

  function pruneProcessedIds() {
    if (processedMessageIds.size > MAX_PROCESSED_IDS) {
      const iterator = processedMessageIds.values();
      for (let i = 0; i < 1000; i++) {
        processedMessageIds.delete(iterator.next().value);
      }
    }
  }

  // =========================================================================
  // MutationObserver — Main Chat
  // =========================================================================

  function setupMainObserver() {
    if (mainObserver) {
      mainObserver.disconnect();
      mainObserver = null;
    }

    const container = findMessageContainer();
    if (!container) {
      log('Message container not found, retrying in 2s...');
      setTimeout(setupMainObserver, 2000);
      return;
    }

    logAlways('✅ Main chat observer attached to:', container.tagName, container.className?.substring?.(0, 60) || '');

    mainObserver = new MutationObserver((mutations) => {
      if (!isReady || !monitoringEnabled) return;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;

          // Check if this node is or contains message elements
          processNewNode(node);
        }
      }
    });

    mainObserver.observe(container, {
      childList: true,
      subtree: true
    });
  }

  /**
   * Process a newly added DOM node, looking for message elements within it.
   */
  function processNewNode(node) {
    // Direct message element
    if (node.getAttribute?.('data-id') ||
        node.classList?.contains('message-in') ||
        node.classList?.contains('message-out')) {
      processMessageElement(node);
    }

    // Search for messages within the node
    const messages = queryAll(node,
      '.message-in',
      '.message-out',
      '[data-id^="true_"]',
      '[data-id^="false_"]',
      'div[data-id]'
    );

    const seen = new Set();
    for (const msg of messages) {
      const id = getMessageId(msg);
      if (id && !seen.has(id)) {
        seen.add(id);
        processMessageElement(msg);
      }
    }
  }

  // =========================================================================
  // Polling Fallback — Catches anything MutationObserver misses
  // =========================================================================

  function startPolling() {
    if (pollingInterval) clearInterval(pollingInterval);

    pollingInterval = setInterval(() => {
      if (!isReady || !monitoringEnabled) return;
      pollForNewMessages();
    }, POLL_INTERVAL);

    log('Polling fallback started (every 2s)');
  }

  function pollForNewMessages() {
    const messages = findAllMessages();
    const currentCount = messages.length;

    // Only process if we see new messages since last poll
    if (currentCount > lastKnownMessageCount) {
      // Process the last few messages (likely the new ones)
      const newCount = currentCount - lastKnownMessageCount;
      const startIdx = Math.max(0, messages.length - newCount - 1);

      for (let i = startIdx; i < messages.length; i++) {
        processMessageElement(messages[i]);
      }
    }

    lastKnownMessageCount = currentCount;
  }

  // =========================================================================
  // Sidebar Observer — Unread Badge Detection
  // =========================================================================

  const knownUnreadCounts = new Map();

  function setupSidebarObserver() {
    if (sidebarObserver) {
      sidebarObserver.disconnect();
      sidebarObserver = null;
    }

    const sidePane = document.querySelector('#pane-side');
    if (!sidePane) {
      log('Sidebar not found, retrying in 2s...');
      setTimeout(setupSidebarObserver, 2000);
      return;
    }

    logAlways('✅ Sidebar observer attached');

    sidebarObserver = new MutationObserver(() => {
      if (!isReady || !monitoringEnabled) return;
      clearTimeout(sidebarObserver._debounce);
      sidebarObserver._debounce = setTimeout(scanSidebarUnreads, 500);
    });

    sidebarObserver.observe(sidePane, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });
  }

  function scanSidebarUnreads() {
    if (!triggerGroup) return;

    // Find all chat list items in sidebar
    const chatItems = queryAll(document,
      '#pane-side [role="listitem"]',
      '#pane-side [data-testid="cell-frame-container"]',
      '#pane-side [data-testid="chat-list-item"]',
      '#pane-side > div > div > div > div'
    );

    for (const item of chatItems) {
      // Find the chat name
      const nameEl = queryFirst(item,
        'span[title]',
        'span[dir="auto"]'
      );
      if (!nameEl) continue;

      const chatName = nameEl.getAttribute('title') || nameEl.textContent?.trim() || '';
      if (!chatName) continue;

      // Check if this matches our trigger group
      if (!matchesGroupName(chatName, triggerGroup)) continue;

      // Look for unread badge
      const badge = queryFirst(item,
        '[data-testid="icon-unread-count"]',
        'span[data-testid="icon-unread-count"]',
        'span[aria-label*="unread"]',
        // Generic: a small circular span with a number inside the chat item
        'span.aumms1qt',  // WhatsApp sometimes uses this class
        'span[class*="unread"]'
      );

      if (badge) {
        const countText = badge.textContent?.trim() || '0';
        const count = parseInt(countText, 10) || 0;
        const prev = knownUnreadCounts.get(chatName) || 0;

        if (count > 0 && count > prev) {
          logAlways(`📬 Unread detected in sidebar: "${chatName}" (${prev} → ${count})`);
          knownUnreadCounts.set(chatName, count);

          chrome.runtime.sendMessage({
            type: 'UNREAD_INDICATOR',
            data: { group: chatName, unreadCount: count, timestamp: Date.now() }
          }).catch(() => {});
        } else {
          knownUnreadCounts.set(chatName, count);
        }
      } else {
        knownUnreadCounts.set(chatName, 0);
      }
    }
  }

  // =========================================================================
  // Group Name Matching
  // =========================================================================

  function matchesGroupName(incoming, configured) {
    if (!incoming || !configured) return false;
    const a = incoming.trim().toLowerCase().replace(/\s+/g, ' ');
    const b = configured.trim().toLowerCase().replace(/\s+/g, ' ');
    return a === b || a.includes(b) || b.includes(a);
  }

  // =========================================================================
  // Navigation Observer — Detect chat switches
  // =========================================================================

  function setupNavigationObserver() {
    // Watch for changes to #main (indicates chat switch)
    const mainEl = document.getElementById('main');
    if (!mainEl) {
      setTimeout(setupNavigationObserver, 2000);
      return;
    }

    const navObs = new MutationObserver(() => {
      log('Chat switched, re-attaching observer...');
      lastKnownMessageCount = 0;
      setTimeout(() => {
        markExistingMessagesAsProcessed();
        setupMainObserver();
      }, 500);
    });

    navObs.observe(mainEl, { childList: true });
    logAlways('✅ Navigation observer attached');
  }

  // =========================================================================
  // Mark Existing Messages (prevent false triggers on load)
  // =========================================================================

  function markExistingMessagesAsProcessed() {
    const messages = findAllMessages();
    for (const msg of messages) {
      const id = getMessageId(msg);
      if (id) processedMessageIds.add(id);
    }
    lastKnownMessageCount = messages.length;
    logAlways(`📝 Marked ${messages.length} existing messages as processed`);
  }

  // =========================================================================
  // Communication with Background
  // =========================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'MONITORING_STATE_CHANGED':
        monitoringEnabled = message.enabled;
        // Also accept group names if provided
        if (message.triggerGroup) triggerGroup = message.triggerGroup;
        if (message.stopGroup) stopGroup = message.stopGroup;
        logAlways('Monitoring state changed:', monitoringEnabled,
          'Trigger:', triggerGroup, 'Stop:', stopGroup);
        if (monitoringEnabled) {
          // If group names are still empty, load from storage
          if (!triggerGroup || !stopGroup) {
            chrome.storage.sync.get(['triggerGroup', 'stopGroup']).then(stored => {
              if (stored.triggerGroup) triggerGroup = stored.triggerGroup;
              if (stored.stopGroup) stopGroup = stored.stopGroup;
              logAlways('Loaded groups from storage — Trigger:', triggerGroup, 'Stop:', stopGroup);
            });
          }
          markExistingMessagesAsProcessed();
          setupMainObserver();
          setupSidebarObserver();
          startPolling();
        } else {
          if (pollingInterval) clearInterval(pollingInterval);
        }
        sendResponse({ success: true });
        break;

      case 'SETTINGS_UPDATED':
        triggerGroup = message.triggerGroup || '';
        stopGroup = message.stopGroup || '';
        knownUnreadCounts.clear();
        logAlways('Settings updated — trigger:', triggerGroup, 'stop:', stopGroup);
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: false });
    }
  });

  // =========================================================================
  // Initialization
  // =========================================================================

  async function initialize() {
    logAlways('🚀 Initializing content script...');

    // Connect to background
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY' });
      if (response?.success) {
        monitoringEnabled = response.monitoringEnabled || false;
        triggerGroup = response.triggerGroup || '';
        stopGroup = response.stopGroup || '';
        logAlways('Connected to background. Monitoring:', monitoringEnabled,
          'Trigger:', triggerGroup, 'Stop:', stopGroup);
      }
    } catch (err) {
      logError('Failed to connect to background:', err.message);
    }

    // Fallback: always also read settings from storage directly
    try {
      const stored = await chrome.storage.sync.get([
        'triggerGroup', 'stopGroup', 'monitoringEnabled', 'devLogs'
      ]);
      if (!triggerGroup && stored.triggerGroup) triggerGroup = stored.triggerGroup;
      if (!stopGroup && stored.stopGroup) stopGroup = stored.stopGroup;
      if (!monitoringEnabled && stored.monitoringEnabled) monitoringEnabled = stored.monitoringEnabled;
      devLogs = stored.devLogs || false;
      logAlways('Settings from storage — Monitoring:', monitoringEnabled,
        'Trigger:', triggerGroup, 'Stop:', stopGroup);
    } catch (e) {
      logError('Failed to load settings from storage:', e);
    }

    // Mark existing messages
    markExistingMessagesAsProcessed();

    // Set up observers
    setupMainObserver();
    setupSidebarObserver();
    setupNavigationObserver();

    // Start polling fallback
    startPolling();

    // Become ready after delay
    setTimeout(() => {
      isReady = true;
      logAlways('✅ Content script READY — now processing new messages');
      // Re-mark to be safe (in case messages loaded during delay)
      markExistingMessagesAsProcessed();
    }, READY_DELAY);
  }

  /**
   * Wait for WhatsApp Web to fully load before initializing.
   */
  function waitForWhatsApp() {
    // Check for various indicators that WhatsApp Web is loaded
    const loaded = queryFirst(document,
      '#pane-side',                              // Sidebar loaded
      '#app .two',                               // Legacy layout
      '#app [data-testid="chat-list"]',          // Chat list loaded
      '[data-testid="default-user"]',            // User avatar
      '#side',                                   // Side panel
      'div[data-testid="chat-list"]'             // Chat list
    );

    if (loaded) {
      logAlways('WhatsApp Web detected as loaded');
      // Small extra delay to let everything settle
      setTimeout(initialize, 1000);
    } else {
      log('Waiting for WhatsApp Web to load...');
      setTimeout(waitForWhatsApp, 1500);
    }
  }

  // Start
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    waitForWhatsApp();
  } else {
    document.addEventListener('DOMContentLoaded', waitForWhatsApp);
  }

  // Listen for storage changes
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.devLogs) devLogs = changes.devLogs.newValue || false;
  });

  logAlways('📦 Content script loaded, waiting for WhatsApp Web...');
})();
