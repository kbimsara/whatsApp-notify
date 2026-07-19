/**
 * content.js — WhatsApp Web DOM Observer
 *
 * Content script that runs on https://web.whatsapp.com/*
 * 
 * Responsibilities:
 *   - Observe DOM using MutationObserver for new messages
 *   - Identify the currently active chat/group name
 *   - Extract message text, sender, and unique message ID
 *   - Prevent duplicate processing of the same message
 *   - Observe sidebar for unread indicators on monitored groups
 *   - Send structured events to the background service worker
 * 
 * Key Design:
 *   - Uses a "ready" flag that delays processing by ~2s after injection
 *     to skip messages that are part of the initial DOM load / history.
 *   - Processes only genuinely new messages (added nodes, not mutations
 *     of existing ones).
 *   - Deduplicates using a Set of processed message identifiers.
 */

(() => {
  'use strict';

  // =========================================================================
  // Constants
  // =========================================================================

  // WhatsApp Web CSS selectors (updated for current WhatsApp Web UI)
  // These may need periodic updates as WhatsApp changes their DOM structure
  const SELECTORS = {
    // Main chat pane — the scrollable message container
    messageContainer: '#main [role="application"]',
    // Fallback message container selectors
    messageContainerAlt: '#main .copyable-area > div[tabindex="-1"]',
    // Individual message rows
    messageRow: '[data-id]',
    // Message text content
    messageText: '.selectable-text span',
    // Message text fallback
    messageTextAlt: '.copyable-text span',
    // Group/contact header in the active chat
    chatHeader: '#main header span[title]',
    // Chat header alt
    chatHeaderAlt: '#main header [data-testid="conversation-info-header-chat-title"]',
    // Outgoing message marker (own messages)
    outgoingMessage: '.message-out',
    // Incoming message
    incomingMessage: '.message-in',
    // Sidebar chat list
    chatList: '#pane-side [role="listitem"]',
    chatListAlt: '#pane-side [data-testid="cell-frame-container"]',
    // Chat name in sidebar
    chatListName: 'span[title]',
    // Unread badge in sidebar
    unreadBadge: '[data-testid="icon-unread-count"]',
    unreadBadgeAlt: 'span[data-testid="icon-unread-count"]',
    // Sidebar pane
    sidePane: '#pane-side',
    // Message sender name (in group chats)
    senderName: 'span[data-testid="msg-meta"]',
    senderNameAlt: '[data-pre-plain-text]'
  };

  // How long to wait before starting to process messages (ms)
  // This allows the initial DOM load to complete without triggering false alarms
  const READY_DELAY = 3000;

  // Maximum number of processed message IDs to retain (memory management)
  const MAX_PROCESSED_IDS = 5000;

  // =========================================================================
  // State
  // =========================================================================

  let isReady = false;
  let monitoringEnabled = false;
  let triggerGroup = '';
  let stopGroup = '';
  let mainObserver = null;
  let sidebarObserver = null;
  const processedMessageIds = new Set();
  let devLogs = false;

  // =========================================================================
  // Logging
  // =========================================================================

  function log(...args) {
    if (devLogs) {
      console.log('[WA-Alert Content]', ...args);
    }
  }

  // =========================================================================
  // DOM Helpers
  // =========================================================================

  /**
   * Query with multiple fallback selectors.
   */
  function querySelector(parent, ...selectors) {
    for (const sel of selectors) {
      const el = parent.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /**
   * Get the currently active chat/group name from the header.
   */
  function getActiveChatName() {
    const header = querySelector(document, SELECTORS.chatHeader, SELECTORS.chatHeaderAlt);
    if (header) {
      return header.getAttribute('title') || header.textContent?.trim() || '';
    }
    return '';
  }

  /**
   * Extract text content from a message element.
   */
  function getMessageText(messageEl) {
    const textEl = querySelector(messageEl, SELECTORS.messageText, SELECTORS.messageTextAlt);
    if (textEl) {
      return textEl.textContent?.trim() || '';
    }
    // Also check for direct text content in copyable area
    const copyable = messageEl.querySelector('.copyable-text');
    if (copyable) {
      // Get text from all span children
      const spans = copyable.querySelectorAll('span');
      for (const span of spans) {
        const text = span.textContent?.trim();
        if (text) return text;
      }
    }
    return '';
  }

  /**
   * Extract sender name from a message element (for group chats).
   */
  function getSenderName(messageEl) {
    // Method 1: data-pre-plain-text attribute contains "[time, sender] " format
    const preText = messageEl.querySelector(SELECTORS.senderNameAlt);
    if (preText) {
      const attr = preText.getAttribute('data-pre-plain-text');
      if (attr) {
        const match = attr.match(/\] (.+?):/);
        if (match) return match[1].trim();
      }
    }
    // Method 2: sender name span
    const senderEl = messageEl.querySelector('span[aria-label]');
    if (senderEl) {
      const label = senderEl.getAttribute('aria-label');
      if (label && !label.includes(':')) return label.trim();
    }
    return 'Unknown';
  }

  /**
   * Check if a message element is an outgoing (own) message.
   */
  function isOwnMessage(messageEl) {
    return messageEl.closest(SELECTORS.outgoingMessage) !== null || 
           messageEl.classList.contains('message-out');
  }

  /**
   * Get a unique identifier for a message element.
   * Uses the data-id attribute which WhatsApp assigns to each message.
   */
  function getMessageId(messageEl) {
    // Walk up to find the nearest element with data-id
    let el = messageEl;
    while (el && !el.getAttribute('data-id')) {
      el = el.parentElement;
    }
    if (el) return el.getAttribute('data-id');
    
    // Fallback: create a hash from text + timestamp
    const text = getMessageText(messageEl);
    const time = messageEl.querySelector('span[data-testid="msg-time"]')?.textContent || '';
    return `fallback_${text}_${time}`;
  }

  // =========================================================================
  // Message Processing
  // =========================================================================

  /**
   * Process a potentially new message element.
   */
  function processMessageElement(messageEl) {
    if (!isReady || !monitoringEnabled) return;

    // Get message ID for deduplication
    const msgId = getMessageId(messageEl);
    if (!msgId || processedMessageIds.has(msgId)) return;

    // Mark as processed
    processedMessageIds.add(msgId);

    // Memory management: trim the set if too large
    if (processedMessageIds.size > MAX_PROCESSED_IDS) {
      const iterator = processedMessageIds.values();
      for (let i = 0; i < 1000; i++) {
        processedMessageIds.delete(iterator.next().value);
      }
    }

    // Get the active chat name
    const group = getActiveChatName();
    if (!group) return;

    // Extract message details
    const text = getMessageText(messageEl);
    const sender = getSenderName(messageEl);
    const ownMsg = isOwnMessage(messageEl);

    if (!text) return; // Skip empty messages (images, etc.)

    log(`New message in "${group}" from ${sender}: "${text}" (own: ${ownMsg})`);

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
      // Extension context may have been invalidated
      log('Failed to send message to background:', err);
    });
  }

  // =========================================================================
  // Main Chat Observer
  // =========================================================================

  /**
   * Set up MutationObserver on the main chat message container.
   */
  function setupMainObserver() {
    // Disconnect existing observer
    if (mainObserver) {
      mainObserver.disconnect();
      mainObserver = null;
    }

    // Find the message container
    const container = querySelector(
      document,
      SELECTORS.messageContainer,
      SELECTORS.messageContainerAlt
    );

    if (!container) {
      log('Message container not found, retrying in 2s...');
      setTimeout(setupMainObserver, 2000);
      return;
    }

    log('Setting up main chat observer');

    mainObserver = new MutationObserver((mutations) => {
      if (!isReady || !monitoringEnabled) return;

      for (const mutation of mutations) {
        // Only process added nodes (new messages)
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;

          // Check if this node IS a message or CONTAINS messages
          const messages = [];

          if (node.getAttribute('data-id')) {
            messages.push(node);
          }

          // Search for message elements within added node
          const innerMessages = node.querySelectorAll(SELECTORS.messageRow);
          messages.push(...innerMessages);

          // Also check for message-in / message-out classes
          if (node.classList?.contains('message-in') || node.classList?.contains('message-out')) {
            messages.push(node);
          }

          const innerTyped = node.querySelectorAll('.message-in, .message-out');
          messages.push(...innerTyped);

          // Process unique messages
          const seen = new Set();
          for (const msg of messages) {
            const id = getMessageId(msg);
            if (id && !seen.has(id)) {
              seen.add(id);
              processMessageElement(msg);
            }
          }
        }
      }
    });

    mainObserver.observe(container, {
      childList: true,
      subtree: true
    });

    log('Main chat observer active');
  }

  // =========================================================================
  // Sidebar Observer (Unread Detection)
  // =========================================================================

  /**
   * Track known unread counts per group to detect *new* unreads.
   */
  const knownUnreadCounts = new Map();

  /**
   * Set up MutationObserver on the sidebar to detect unread indicators.
   * This enables trigger detection even when the trigger group isn't active.
   */
  function setupSidebarObserver() {
    if (sidebarObserver) {
      sidebarObserver.disconnect();
      sidebarObserver = null;
    }

    const sidePane = document.querySelector(SELECTORS.sidePane);
    if (!sidePane) {
      log('Sidebar not found, retrying in 2s...');
      setTimeout(setupSidebarObserver, 2000);
      return;
    }

    log('Setting up sidebar observer');

    sidebarObserver = new MutationObserver((mutations) => {
      if (!isReady || !monitoringEnabled) return;

      // Debounce: process after a small delay
      clearTimeout(sidebarObserver._debounceTimer);
      sidebarObserver._debounceTimer = setTimeout(() => {
        checkSidebarUnreads();
      }, 500);
    });

    sidebarObserver.observe(sidePane, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });

    log('Sidebar observer active');
  }

  /**
   * Scan sidebar for unread indicators matching the trigger group.
   */
  function checkSidebarUnreads() {
    if (!triggerGroup) return;

    const chatItems = document.querySelectorAll(
      `${SELECTORS.chatList}, ${SELECTORS.chatListAlt}`
    );

    for (const item of chatItems) {
      const nameEl = item.querySelector(SELECTORS.chatListName);
      if (!nameEl) continue;

      const chatName = nameEl.getAttribute('title') || nameEl.textContent?.trim() || '';
      
      // Check if this is our trigger group
      const normalizedChat = chatName.trim().toLowerCase().replace(/\s+/g, ' ');
      const normalizedTrigger = triggerGroup.trim().toLowerCase().replace(/\s+/g, ' ');
      
      if (!normalizedChat.includes(normalizedTrigger) && !normalizedTrigger.includes(normalizedChat)) {
        continue;
      }

      // Check for unread badge
      const badge = querySelector(item, SELECTORS.unreadBadge, SELECTORS.unreadBadgeAlt);
      if (badge) {
        const countText = badge.textContent?.trim() || '0';
        const count = parseInt(countText, 10) || 0;
        const previousCount = knownUnreadCounts.get(chatName) || 0;

        if (count > previousCount) {
          log(`New unread in trigger group "${chatName}": ${previousCount} → ${count}`);
          knownUnreadCounts.set(chatName, count);

          // Notify background
          chrome.runtime.sendMessage({
            type: 'UNREAD_INDICATOR',
            data: {
              group: chatName,
              unreadCount: count,
              timestamp: Date.now()
            }
          }).catch(() => {});
        } else {
          knownUnreadCounts.set(chatName, count);
        }
      } else {
        // No badge = no unreads, reset
        knownUnreadCounts.set(chatName, 0);
      }
    }
  }

  // =========================================================================
  // Navigation Observer (detect chat switches)
  // =========================================================================

  /**
   * Watch for navigation changes (switching between chats).
   * Re-attach the main observer when the chat pane changes.
   */
  function setupNavigationObserver() {
    const mainEl = document.getElementById('main');
    if (!mainEl) {
      log('#main not found, retrying in 2s...');
      setTimeout(setupNavigationObserver, 2000);
      return;
    }

    const navObserver = new MutationObserver(() => {
      // Chat may have changed, re-attach main observer
      setTimeout(setupMainObserver, 500);
    });

    navObserver.observe(mainEl, {
      childList: true
    });

    log('Navigation observer active');
  }

  // =========================================================================
  // Reconnection & Recovery
  // =========================================================================

  /**
   * Watch for the app element to handle WhatsApp Web refreshes.
   */
  function setupAppObserver() {
    const appEl = document.getElementById('app');
    if (!appEl) {
      log('#app not found, retrying in 2s...');
      setTimeout(setupAppObserver, 2000);
      return;
    }

    const appObserver = new MutationObserver(() => {
      log('App DOM changed, re-initializing observers...');
      setTimeout(initialize, 2000);
    });

    appObserver.observe(appEl, {
      childList: true
    });

    log('App recovery observer active');
  }

  // =========================================================================
  // Communication with Background
  // =========================================================================

  /**
   * Listen for messages from background service worker.
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'MONITORING_STATE_CHANGED':
        monitoringEnabled = message.enabled;
        log('Monitoring state changed:', monitoringEnabled);
        if (monitoringEnabled) {
          // Re-initialize observers
          setupMainObserver();
          setupSidebarObserver();
        }
        sendResponse({ success: true });
        break;

      case 'SETTINGS_UPDATED':
        triggerGroup = message.triggerGroup || '';
        stopGroup = message.stopGroup || '';
        knownUnreadCounts.clear(); // Reset unread tracking
        log('Settings updated — trigger:', triggerGroup, 'stop:', stopGroup);
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: false, error: 'Unknown message type' });
    }
  });

  // =========================================================================
  // Initialization
  // =========================================================================

  /**
   * Mark all currently visible messages as "already processed"
   * to prevent triggering on historical messages.
   */
  function markExistingMessagesAsProcessed() {
    const messages = document.querySelectorAll(SELECTORS.messageRow);
    for (const msg of messages) {
      const id = getMessageId(msg);
      if (id) {
        processedMessageIds.add(id);
      }
    }

    // Also mark messages by class
    const typed = document.querySelectorAll('.message-in, .message-out');
    for (const msg of typed) {
      const id = getMessageId(msg);
      if (id) {
        processedMessageIds.add(id);
      }
    }

    log(`Marked ${processedMessageIds.size} existing messages as processed`);
  }

  /**
   * Initialize the content script.
   */
  async function initialize() {
    log('Initializing content script...');

    // Connect to background and get current state
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'CONTENT_SCRIPT_READY'
      });

      if (response?.success) {
        monitoringEnabled = response.monitoringEnabled || false;
        triggerGroup = response.triggerGroup || '';
        stopGroup = response.stopGroup || '';
        log('Connected to background. Monitoring:', monitoringEnabled);
      }
    } catch (err) {
      log('Failed to connect to background:', err);
    }

    // Load dev logs setting
    try {
      const stored = await chrome.storage.sync.get('devLogs');
      devLogs = stored.devLogs || false;
    } catch (e) { /* ignore */ }

    // Mark existing messages to avoid false triggers
    markExistingMessagesAsProcessed();

    // Set up observers
    setupMainObserver();
    setupSidebarObserver();
    setupNavigationObserver();

    // Start processing new messages after delay
    setTimeout(() => {
      isReady = true;
      log('Content script ready — now processing new messages');
    }, READY_DELAY);
  }

  // Wait for WhatsApp Web to fully load
  function waitForWhatsApp() {
    const appLoaded = document.querySelector('#app .two, #app [data-testid="chat-list"]');
    if (appLoaded) {
      initialize();
    } else {
      log('Waiting for WhatsApp Web to load...');
      setTimeout(waitForWhatsApp, 1000);
    }
  }

  // Kick off
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    waitForWhatsApp();
  } else {
    document.addEventListener('DOMContentLoaded', waitForWhatsApp);
  }

  // Also set up app-level observer for recovery from full-page refreshes
  setupAppObserver();

  // Listen for storage changes to update devLogs
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.devLogs) {
      devLogs = changes.devLogs.newValue || false;
    }
  });

  log('Content script loaded');
})();
