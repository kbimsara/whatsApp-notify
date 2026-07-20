/**
 * background.js — Background Service Worker
 * 
 * Central controller for the WhatsApp Alert System extension.
 * 
 * Responsibilities:
 *   - Manage monitoring state (enabled/disabled)
 *   - Manage alarm state (active/inactive)
 *   - Receive trigger and stop events from content script
 *   - Control offscreen document for audio playback
 *   - Update badge icon and text
 *   - Send desktop notifications
 *   - Persist state across extension restarts
 *   - Communicate with popup for UI updates
 */

(() => {
  'use strict';

  // =========================================================================
  // State
  // =========================================================================

  let state = {
    monitoringEnabled: false,
    alarmActive: false,
    lastTriggerTime: null,
    lastStopTime: null,
    lastTriggerMessage: '',
    lastTriggerGroup: '',
    lastStopGroup: ''
  };

  // Default settings
  const DEFAULT_SETTINGS = {
    triggerGroup: '',
    stopGroup: '',
    stopCommands: ['STOP', 'stop', 'Resolved', 'Issue Fixed', 'BUZZER STOP', 'ALARM OFF', '#stop', 'Emergency Cleared'],
    alarmVolume: 1.0,
    customAlarmSrc: null,
    monitoringEnabled: false,
    ignoreOwnMessages: true,
    desktopNotifications: true,
    badgeNotifications: true,
    partialMatch: true,
    devLogs: false
  };

  let settings = { ...DEFAULT_SETTINGS };
  let offscreenDocumentExists = false;

  // =========================================================================
  // Logging
  // =========================================================================

  function log(...args) {
    if (settings.devLogs) {
      console.log('[BG]', ...args);
    }
  }

  function logError(...args) {
    console.error('[BG]', ...args);
  }

  // =========================================================================
  // Settings Management
  // =========================================================================

  /**
   * Load settings from chrome.storage.sync
   */
  async function loadSettings() {
    try {
      const stored = await chrome.storage.sync.get(null);
      settings = { ...DEFAULT_SETTINGS, ...stored };
      log('Settings loaded:', settings);
    } catch (err) {
      logError('Failed to load settings:', err);
    }
  }

  /**
   * Load persisted runtime state from chrome.storage.local
   */
  async function loadState() {
    try {
      const stored = await chrome.storage.local.get('runtimeState');
      if (stored.runtimeState) {
        state = { ...state, ...stored.runtimeState };
        // On service worker restart, if alarm was active, we need to re-check
        // but we can't guarantee the alarm audio survived. Reset alarm state.
        if (state.alarmActive) {
          log('Service worker restarted while alarm was active. Restarting alarm.');
          await startAlarm();
        }
      }
    } catch (err) {
      logError('Failed to load state:', err);
    }
  }

  /**
   * Persist runtime state to chrome.storage.local
   */
  async function saveState() {
    try {
      await chrome.storage.local.set({ runtimeState: state });
    } catch (err) {
      logError('Failed to save state:', err);
    }
  }

  // =========================================================================
  // Badge Management
  // =========================================================================

  const BADGE_COLORS = {
    disabled: '#6B7280',  // Gray
    monitoring: '#10B981', // Green
    alarm: '#EF4444'       // Red
  };

  /**
   * Update the extension badge based on current state.
   */
  async function updateBadge() {
    if (!settings.badgeNotifications) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }

    try {
      if (state.alarmActive) {
        await chrome.action.setBadgeText({ text: '🔔' });
        await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS.alarm });
      } else if (state.monitoringEnabled) {
        await chrome.action.setBadgeText({ text: 'ON' });
        await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS.monitoring });
      } else {
        await chrome.action.setBadgeText({ text: 'OFF' });
        await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS.disabled });
      }
    } catch (err) {
      logError('Failed to update badge:', err);
    }
  }

  // =========================================================================
  // Offscreen Document Management
  // =========================================================================

  /**
   * Ensure the offscreen document exists for audio playback.
   */
  async function ensureOffscreenDocument() {
    // Check if already exists
    if (offscreenDocumentExists) return;

    try {
      // In Manifest V3, check existing documents
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
      });

      if (existingContexts.length > 0) {
        offscreenDocumentExists = true;
        return;
      }

      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Play alarm audio for WhatsApp alert notifications'
      });
      
      offscreenDocumentExists = true;
      log('Offscreen document created');
    } catch (err) {
      // Document might already exist from a previous service worker lifecycle
      if (err.message?.includes('Only a single offscreen')) {
        offscreenDocumentExists = true;
        log('Offscreen document already exists');
      } else {
        logError('Failed to create offscreen document:', err);
        throw err;
      }
    }
  }

  /**
   * Send a command to the offscreen document.
   */
  async function sendOffscreenCommand(command, data = {}) {
    await ensureOffscreenDocument();
    try {
      return await chrome.runtime.sendMessage({
        target: 'offscreen',
        command,
        ...data
      });
    } catch (err) {
      logError('Offscreen command failed:', err);
      // Offscreen document may have been closed. Recreate.
      offscreenDocumentExists = false;
      await ensureOffscreenDocument();
      return await chrome.runtime.sendMessage({
        target: 'offscreen',
        command,
        ...data
      });
    }
  }

  // =========================================================================
  // Alarm Control
  // =========================================================================

  /**
   * Start the alarm.
   */
  async function startAlarm() {
    if (state.alarmActive) {
      log('Alarm already active, ignoring duplicate trigger');
      return;
    }

    state.alarmActive = true;
    state.lastTriggerTime = new Date().toISOString();
    
    await saveState();
    await updateBadge();

    try {
      await sendOffscreenCommand('PLAY_ALARM', { volume: settings.alarmVolume });
      log('Alarm started');
    } catch (err) {
      logError('Failed to start alarm:', err);
    }

    // Desktop notification
    if (settings.desktopNotifications) {
      try {
        await chrome.notifications.create('alarm-trigger', {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: '🚨 ALARM TRIGGERED',
          message: `New message in "${state.lastTriggerGroup}"${state.lastTriggerMessage ? ': ' + state.lastTriggerMessage.substring(0, 100) : ''}`,
          priority: 2,
          requireInteraction: true
        });
      } catch (err) {
        logError('Notification failed:', err);
      }
    }

    // Broadcast state update to popup
    broadcastState();
  }

  /**
   * Stop the alarm.
   */
  async function stopAlarm(reason = 'manual') {
    if (!state.alarmActive) {
      log('Alarm not active, nothing to stop');
      return;
    }

    state.alarmActive = false;
    state.lastStopTime = new Date().toISOString();

    await saveState();
    await updateBadge();

    try {
      await sendOffscreenCommand('STOP_ALARM');
      log('Alarm stopped, reason:', reason);
    } catch (err) {
      logError('Failed to stop alarm:', err);
    }

    // Desktop notification
    if (settings.desktopNotifications) {
      try {
        // Clear the trigger notification
        await chrome.notifications.clear('alarm-trigger');
        
        await chrome.notifications.create('alarm-stop', {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: '✅ Alarm Stopped',
          message: `Alarm stopped by "${state.lastStopGroup}" — ${reason}`,
          priority: 1
        });
        
        // Auto-close stop notification after 5 seconds
        setTimeout(async () => {
          try { await chrome.notifications.clear('alarm-stop'); } catch (e) { /* ignore */ }
        }, 5000);
      } catch (err) {
        logError('Notification failed:', err);
      }
    }

    // Broadcast state update to popup
    broadcastState();
  }

  // =========================================================================
  // Stop Command Matching
  // =========================================================================

  /**
   * Check if a message text matches any configured stop command.
   * @param {string} text - The incoming message text
   * @returns {boolean} - True if matched
   */
  function matchesStopCommand(text) {
    if (!text || !settings.stopCommands || settings.stopCommands.length === 0) {
      return false;
    }

    const normalizedText = text.trim().toLowerCase();

    for (const cmd of settings.stopCommands) {
      const normalizedCmd = cmd.trim().toLowerCase();
      if (!normalizedCmd) continue;

      if (settings.partialMatch) {
        // Partial/contains match
        if (normalizedText.includes(normalizedCmd)) {
          log(`Stop command matched (partial): "${cmd}" in "${text}"`);
          return true;
        }
      } else {
        // Exact match (after trimming and lowercasing)
        if (normalizedText === normalizedCmd) {
          log(`Stop command matched (exact): "${cmd}" = "${text}"`);
          return true;
        }
      }
    }

    return false;
  }

  // =========================================================================
  // Group Name Matching
  // =========================================================================

  /**
   * Check if a group name matches the configured group.
   * Case-insensitive, trim whitespace, and handle emoji spacing.
   */
  function matchesGroup(incoming, configured) {
    if (!incoming || !configured) return false;
    const a = incoming.trim().toLowerCase().replace(/\s+/g, ' ');
    const b = configured.trim().toLowerCase().replace(/\s+/g, ' ');
    return a === b || a.includes(b) || b.includes(a);
  }

  // =========================================================================
  // Message Handling
  // =========================================================================

  /**
   * Handle a new message event from the content script.
   */
  async function handleNewMessage(data) {
    log('New message received:', data);

    if (!state.monitoringEnabled) {
      log('Monitoring disabled, ignoring message');
      return;
    }

    const { group, text, sender, isOwnMessage, source } = data;

    // Check if we should ignore own messages
    if (settings.ignoreOwnMessages && isOwnMessage) {
      log('Ignoring own message');
      return;
    }

    // --- TRIGGER CHECK ---
    if (matchesGroup(group, settings.triggerGroup)) {
      log(`Message in trigger group "${group}"`);
      state.lastTriggerGroup = group;
      state.lastTriggerMessage = text || '';
      
      if (!state.alarmActive) {
        await startAlarm();
      } else {
        log('Alarm already active, ignoring additional trigger');
      }
    }

    // --- STOP CHECK ---
    if (state.alarmActive && matchesGroup(group, settings.stopGroup)) {
      log(`Message in stop group "${group}", checking stop commands...`);
      
      if (matchesStopCommand(text)) {
        state.lastStopGroup = group;
        await stopAlarm(`Stop command matched: "${text}"`);
      } else {
        log(`Message "${text}" did not match any stop command`);
      }
    }
  }

  /**
   * Handle unread indicator event from sidebar observer.
   * This fires when the trigger group gets new unread messages
   * even when it's not the active chat.
   */
  async function handleUnreadIndicator(data) {
    log('Unread indicator detected:', data);

    if (!state.monitoringEnabled) return;
    
    const { group } = data;

    if (matchesGroup(group, settings.triggerGroup)) {
      log(`Unread indicator for trigger group "${group}"`);
      state.lastTriggerGroup = group;
      state.lastTriggerMessage = '(Unread message detected via sidebar)';
      
      if (!state.alarmActive) {
        await startAlarm();
      }
    }
  }

  // =========================================================================
  // Broadcast State to Popup
  // =========================================================================

  function broadcastState() {
    const stateMessage = {
      type: 'STATE_UPDATE',
      state: { ...state },
      settings: { ...settings }
    };

    // Send to popup (if open)
    chrome.runtime.sendMessage(stateMessage).catch(() => {
      // Popup not open, ignore
    });
  }

  // =========================================================================
  // Message Listener
  // =========================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Ignore messages targeted at offscreen document
    if (message.target === 'offscreen') return;

    log('Message received:', message.type);

    switch (message.type) {
      // --- From Content Script ---
      case 'NEW_MESSAGE':
        handleNewMessage(message.data).then(() => {
          sendResponse({ success: true });
        });
        return true; // async

      case 'UNREAD_INDICATOR':
        handleUnreadIndicator(message.data).then(() => {
          sendResponse({ success: true });
        });
        return true;

      case 'CONTENT_SCRIPT_READY':
        log('Content script connected');
        // Ensure settings are loaded before responding
        loadSettings().then(() => {
          log('Responding to content script with:', {
            monitoringEnabled: state.monitoringEnabled,
            triggerGroup: settings.triggerGroup,
            stopGroup: settings.stopGroup
          });
          sendResponse({
            success: true,
            monitoringEnabled: state.monitoringEnabled,
            triggerGroup: settings.triggerGroup,
            stopGroup: settings.stopGroup
          });
        });
        return true; // async response

      // --- From Popup ---
      case 'GET_STATE':
        sendResponse({
          success: true,
          state: { ...state },
          settings: { ...settings }
        });
        break;

      case 'ENABLE_MONITORING':
        state.monitoringEnabled = true;
        settings.monitoringEnabled = true;
        chrome.storage.sync.set({ monitoringEnabled: true });
        saveState();
        updateBadge();
        broadcastState();
        // Notify content script with group names so it knows what to monitor
        notifyContentScripts({
          type: 'MONITORING_STATE_CHANGED',
          enabled: true,
          triggerGroup: settings.triggerGroup,
          stopGroup: settings.stopGroup
        });
        sendResponse({ success: true });
        break;

      case 'DISABLE_MONITORING':
        state.monitoringEnabled = false;
        settings.monitoringEnabled = false;
        chrome.storage.sync.set({ monitoringEnabled: false });
        // Also stop alarm if active
        if (state.alarmActive) {
          stopAlarm('Monitoring disabled');
        }
        saveState();
        updateBadge();
        broadcastState();
        notifyContentScripts({ type: 'MONITORING_STATE_CHANGED', enabled: false });
        sendResponse({ success: true });
        break;

      case 'SAVE_SETTINGS':
        settings = { ...settings, ...message.settings };
        chrome.storage.sync.set(message.settings).then(() => {
          log('Settings saved:', message.settings);
          broadcastState();
          // If alarm source changed, update offscreen
          if (message.settings.customAlarmSrc !== undefined) {
            const src = message.settings.customAlarmSrc || '__default__';
            sendOffscreenCommand('SET_SOURCE', { src }).catch(() => {});
          }
          if (message.settings.alarmVolume !== undefined) {
            sendOffscreenCommand('SET_VOLUME', { volume: message.settings.alarmVolume }).catch(() => {});
          }
          notifyContentScripts({
            type: 'SETTINGS_UPDATED',
            triggerGroup: settings.triggerGroup,
            stopGroup: settings.stopGroup
          });
          sendResponse({ success: true });
        });
        return true;

      case 'RESET_SETTINGS':
        settings = { ...DEFAULT_SETTINGS };
        state = {
          monitoringEnabled: false,
          alarmActive: false,
          lastTriggerTime: null,
          lastStopTime: null,
          lastTriggerMessage: '',
          lastTriggerGroup: '',
          lastStopGroup: ''
        };
        chrome.storage.sync.clear().then(() => {
          chrome.storage.sync.set(DEFAULT_SETTINGS);
          saveState();
          updateBadge();
          sendOffscreenCommand('STOP_ALARM').catch(() => {});
          sendOffscreenCommand('SET_SOURCE', { src: '__default__' }).catch(() => {});
          broadcastState();
          notifyContentScripts({ type: 'MONITORING_STATE_CHANGED', enabled: false });
          sendResponse({ success: true });
        });
        return true;

      case 'TEST_ALARM':
        ensureOffscreenDocument().then(() => {
          return sendOffscreenCommand('PLAY_ALARM', { volume: settings.alarmVolume });
        }).then(() => {
          // Stop after 3 seconds
          setTimeout(() => {
            sendOffscreenCommand('STOP_ALARM').catch(() => {});
          }, 3000);
          sendResponse({ success: true });
        }).catch(err => {
          sendResponse({ success: false, error: err.message });
        });
        return true;

      case 'STOP_TEST_ALARM':
        sendOffscreenCommand('STOP_ALARM').then(() => {
          sendResponse({ success: true });
        }).catch(err => {
          sendResponse({ success: false, error: err.message });
        });
        return true;

      case 'MANUAL_STOP_ALARM':
        stopAlarm('Manual stop from popup').then(() => {
          sendResponse({ success: true });
        });
        return true;

      default:
        log('Unknown message type:', message.type);
        sendResponse({ success: false, error: 'Unknown message type' });
    }
  });

  /**
   * Notify all WhatsApp Web tabs' content scripts
   */
  async function notifyContentScripts(message) {
    try {
      const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {
          // Content script not ready in this tab, ignore
        });
      }
    } catch (err) {
      logError('Failed to notify content scripts:', err);
    }
  }

  // =========================================================================
  // Storage Change Listener
  // =========================================================================

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync') {
      for (const [key, { newValue }] of Object.entries(changes)) {
        if (key in settings) {
          settings[key] = newValue;
          log(`Setting "${key}" changed to:`, newValue);
        }
      }
    }
  });

  // =========================================================================
  // Installation & Startup
  // =========================================================================

  chrome.runtime.onInstalled.addListener(async (details) => {
    log('Extension installed/updated:', details.reason);
    await loadSettings();
    
    if (details.reason === 'install') {
      // Set defaults on first install
      await chrome.storage.sync.set(DEFAULT_SETTINGS);
    }
    
    await updateBadge();
  });

  chrome.runtime.onStartup.addListener(async () => {
    log('Browser started');
    await loadSettings();
    await loadState();
    await updateBadge();
  });

  // Initialize on service worker load
  (async () => {
    await loadSettings();
    await loadState();
    await updateBadge();
    log('Background service worker initialized');
  })();

})();
