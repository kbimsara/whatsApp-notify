/**
 * popup.js — Popup UI Controller
 * 
 * Manages the extension popup interface, synchronizes state with the
 * background service worker, and handles all user interactions.
 */

(() => {
  'use strict';

  // =========================================================================
  // DOM References
  // =========================================================================

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const DOM = {
    // Header
    headerPulse: $('#headerPulse'),
    headerSubtitle: $('#headerSubtitle'),
    statusDot: $('#statusDot'),
    statusLabel: $('#statusLabel'),

    // Status cards
    monitoringCard: $('#monitoringCard'),
    alarmCard: $('#alarmCard'),
    monitoringStatus: $('#monitoringStatus'),
    alarmStatus: $('#alarmStatus'),
    lastTriggerTime: $('#lastTriggerTime'),
    lastStopTime: $('#lastStopTime'),

    // Monitoring settings
    triggerGroup: $('#triggerGroup'),
    stopGroup: $('#stopGroup'),
    btnEnable: $('#btnEnable'),
    btnDisable: $('#btnDisable'),
    btnStopAlarm: $('#btnStopAlarm'),

    // Stop commands
    stopCommandTags: $('#stopCommandTags'),
    newStopCommand: $('#newStopCommand'),
    btnAddCommand: $('#btnAddCommand'),
    partialMatch: $('#partialMatch'),

    // Alarm settings
    volumeSlider: $('#volumeSlider'),
    volumeValue: $('#volumeValue'),
    btnTestAlarm: $('#btnTestAlarm'),
    btnStopTest: $('#btnStopTest'),
    customAlarmFile: $('#customAlarmFile'),
    btnRestoreDefault: $('#btnRestoreDefault'),
    customAlarmName: $('#customAlarmName'),

    // Advanced settings
    ignoreOwn: $('#ignoreOwn'),
    desktopNotif: $('#desktopNotif'),
    badgeNotif: $('#badgeNotif'),
    devLogs: $('#devLogs'),

    // Footer
    btnSave: $('#btnSave'),
    btnReset: $('#btnReset'),
    toast: $('#toast')
  };

  // =========================================================================
  // State
  // =========================================================================

  let currentState = {};
  let currentSettings = {};
  let stopCommands = [];
  let isTestPlaying = false;

  // =========================================================================
  // Toast Notifications
  // =========================================================================

  let toastTimer = null;

  function showToast(message, type = 'success') {
    clearTimeout(toastTimer);
    DOM.toast.textContent = message;
    DOM.toast.className = `toast ${type} visible`;
    toastTimer = setTimeout(() => {
      DOM.toast.classList.remove('visible');
    }, 2500);
  }

  // =========================================================================
  // Section Toggle (Accordion)
  // =========================================================================

  function initSectionToggles() {
    $$('.section-header[data-toggle]').forEach(header => {
      const targetId = header.getAttribute('data-toggle');
      const body = $(`#${targetId}`);
      const isOpen = body.classList.contains('open');

      if (!isOpen) {
        header.classList.add('collapsed');
      }

      header.addEventListener('click', () => {
        const isCurrentlyOpen = body.classList.contains('open');
        if (isCurrentlyOpen) {
          body.classList.remove('open');
          header.classList.add('collapsed');
        } else {
          body.classList.add('open');
          header.classList.remove('collapsed');
        }
      });
    });
  }

  // =========================================================================
  // Stop Command Tags
  // =========================================================================

  function renderStopCommandTags() {
    DOM.stopCommandTags.innerHTML = '';
    stopCommands.forEach((cmd, index) => {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.innerHTML = `
        <span>${escapeHtml(cmd)}</span>
        <button class="tag-remove" data-index="${index}" title="Remove">&times;</button>
      `;
      DOM.stopCommandTags.appendChild(tag);
    });

    // Attach remove handlers
    DOM.stopCommandTags.querySelectorAll('.tag-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.getAttribute('data-index'), 10);
        stopCommands.splice(idx, 1);
        renderStopCommandTags();
      });
    });
  }

  function addStopCommand() {
    const val = DOM.newStopCommand.value.trim();
    if (!val) return;
    if (stopCommands.includes(val)) {
      showToast('Command already exists', 'error');
      return;
    }
    stopCommands.push(val);
    DOM.newStopCommand.value = '';
    renderStopCommandTags();
    showToast(`Added: "${val}"`, 'info');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // =========================================================================
  // UI State Updates
  // =========================================================================

  function updateUI(state, settings) {
    currentState = state || currentState;
    currentSettings = settings || currentSettings;

    // Header status
    if (currentState.alarmActive) {
      DOM.statusDot.className = 'status-dot alarm';
      DOM.statusLabel.textContent = 'ALARM';
      DOM.headerPulse.classList.add('active');
      DOM.headerSubtitle.textContent = '⚠ Alarm is active!';
    } else if (currentState.monitoringEnabled) {
      DOM.statusDot.className = 'status-dot active';
      DOM.statusLabel.textContent = 'Monitoring';
      DOM.headerPulse.classList.add('active');
      DOM.headerSubtitle.textContent = 'Monitoring for new messages...';
    } else {
      DOM.statusDot.className = 'status-dot';
      DOM.statusLabel.textContent = 'Inactive';
      DOM.headerPulse.classList.remove('active');
      DOM.headerSubtitle.textContent = 'Configure your alert monitor';
    }

    // Status cards
    if (currentState.monitoringEnabled) {
      DOM.monitoringCard.classList.add('active');
      DOM.monitoringStatus.textContent = 'Active';
      DOM.monitoringStatus.style.color = 'var(--success)';
    } else {
      DOM.monitoringCard.classList.remove('active');
      DOM.monitoringStatus.textContent = 'Inactive';
      DOM.monitoringStatus.style.color = 'var(--text-muted)';
    }

    if (currentState.alarmActive) {
      DOM.alarmCard.classList.add('alarm');
      DOM.alarmCard.classList.remove('active');
      DOM.alarmStatus.textContent = '🔔 ACTIVE';
      DOM.alarmStatus.style.color = 'var(--danger)';
    } else {
      DOM.alarmCard.classList.remove('alarm');
      DOM.alarmStatus.textContent = 'Silent';
      DOM.alarmStatus.style.color = 'var(--text-muted)';
    }

    // Times
    DOM.lastTriggerTime.textContent = currentState.lastTriggerTime
      ? formatTime(currentState.lastTriggerTime)
      : '—';
    DOM.lastStopTime.textContent = currentState.lastStopTime
      ? formatTime(currentState.lastStopTime)
      : '—';

    // Buttons
    if (currentState.monitoringEnabled) {
      DOM.btnEnable.style.display = 'none';
      DOM.btnDisable.style.display = '';
    } else {
      DOM.btnEnable.style.display = '';
      DOM.btnDisable.style.display = 'none';
    }

    DOM.btnStopAlarm.style.display = currentState.alarmActive ? '' : 'none';

    // Settings fields (only populate if not currently focused)
    if (document.activeElement !== DOM.triggerGroup) {
      DOM.triggerGroup.value = currentSettings.triggerGroup || '';
    }
    if (document.activeElement !== DOM.stopGroup) {
      DOM.stopGroup.value = currentSettings.stopGroup || '';
    }

    // Stop commands
    if (currentSettings.stopCommands && JSON.stringify(stopCommands) !== JSON.stringify(currentSettings.stopCommands)) {
      stopCommands = [...currentSettings.stopCommands];
      renderStopCommandTags();
    }

    // Toggles
    DOM.partialMatch.checked = currentSettings.partialMatch !== false;
    DOM.ignoreOwn.checked = currentSettings.ignoreOwnMessages !== false;
    DOM.desktopNotif.checked = currentSettings.desktopNotifications !== false;
    DOM.badgeNotif.checked = currentSettings.badgeNotifications !== false;
    DOM.devLogs.checked = currentSettings.devLogs === true;

    // Volume
    const vol = Math.round((currentSettings.alarmVolume ?? 1) * 100);
    DOM.volumeSlider.value = vol;
    DOM.volumeValue.textContent = `${vol}%`;

    // Custom alarm indicator
    if (currentSettings.customAlarmSrc) {
      DOM.customAlarmName.textContent = '✓ Custom alarm loaded';
      DOM.customAlarmName.style.color = 'var(--success)';
    } else {
      DOM.customAlarmName.textContent = 'Using default alarm sound';
      DOM.customAlarmName.style.color = '';
    }
  }

  function formatTime(isoString) {
    try {
      const date = new Date(isoString);
      const now = new Date();
      const diff = now - date;

      // If less than 24 hours, show relative time
      if (diff < 86400000) {
        if (diff < 60000) return 'Just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        return `${Math.floor(diff / 3600000)}h ago`;
      }

      return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (e) {
      return isoString;
    }
  }

  // =========================================================================
  // Communication with Background
  // =========================================================================

  async function sendMessage(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      console.error('Failed to send message:', err);
      showToast('Communication error', 'error');
      return { success: false };
    }
  }

  async function loadState() {
    const response = await sendMessage({ type: 'GET_STATE' });
    if (response?.success) {
      updateUI(response.state, response.settings);
    }
  }

  // =========================================================================
  // Event Listeners
  // =========================================================================

  function initEventListeners() {
    // Enable monitoring
    DOM.btnEnable.addEventListener('click', async () => {
      // Validate inputs
      const triggerGroup = DOM.triggerGroup.value.trim();
      const stopGroup = DOM.stopGroup.value.trim();

      if (!triggerGroup) {
        showToast('Enter a Trigger Group name', 'error');
        DOM.triggerGroup.focus();
        return;
      }
      if (!stopGroup) {
        showToast('Enter a Stop Group name', 'error');
        DOM.stopGroup.focus();
        return;
      }

      // Save settings first
      await saveSettings();
      
      const response = await sendMessage({ type: 'ENABLE_MONITORING' });
      if (response?.success) {
        showToast('Monitoring enabled ✓', 'success');
        await loadState();
      }
    });

    // Disable monitoring
    DOM.btnDisable.addEventListener('click', async () => {
      const response = await sendMessage({ type: 'DISABLE_MONITORING' });
      if (response?.success) {
        showToast('Monitoring disabled', 'info');
        await loadState();
      }
    });

    // Stop alarm
    DOM.btnStopAlarm.addEventListener('click', async () => {
      const response = await sendMessage({ type: 'MANUAL_STOP_ALARM' });
      if (response?.success) {
        showToast('Alarm stopped ✓', 'success');
        await loadState();
      }
    });

    // Add stop command
    DOM.btnAddCommand.addEventListener('click', addStopCommand);
    DOM.newStopCommand.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') addStopCommand();
    });

    // Volume slider
    DOM.volumeSlider.addEventListener('input', () => {
      const val = DOM.volumeSlider.value;
      DOM.volumeValue.textContent = `${val}%`;
    });

    // Test alarm
    DOM.btnTestAlarm.addEventListener('click', async () => {
      const response = await sendMessage({ type: 'TEST_ALARM' });
      if (response?.success) {
        isTestPlaying = true;
        DOM.btnTestAlarm.style.display = 'none';
        DOM.btnStopTest.style.display = '';
        showToast('Testing alarm (3s)', 'info');
        
        setTimeout(() => {
          isTestPlaying = false;
          DOM.btnTestAlarm.style.display = '';
          DOM.btnStopTest.style.display = 'none';
        }, 3000);
      }
    });

    // Stop test alarm
    DOM.btnStopTest.addEventListener('click', async () => {
      await sendMessage({ type: 'STOP_TEST_ALARM' });
      isTestPlaying = false;
      DOM.btnTestAlarm.style.display = '';
      DOM.btnStopTest.style.display = 'none';
    });

    // Custom alarm upload
    DOM.customAlarmFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      if (file.size > 5 * 1024 * 1024) {
        showToast('File too large (max 5MB)', 'error');
        return;
      }

      try {
        const reader = new FileReader();
        reader.onload = () => {
          currentSettings.customAlarmSrc = reader.result;
          DOM.customAlarmName.textContent = `✓ ${file.name}`;
          DOM.customAlarmName.style.color = 'var(--success)';
          showToast(`Loaded: ${file.name}`, 'success');
        };
        reader.readAsDataURL(file);
      } catch (err) {
        showToast('Failed to load file', 'error');
      }
    });

    // Restore default alarm
    DOM.btnRestoreDefault.addEventListener('click', () => {
      currentSettings.customAlarmSrc = null;
      DOM.customAlarmName.textContent = 'Using default alarm sound';
      DOM.customAlarmName.style.color = '';
      showToast('Default alarm restored', 'info');
    });

    // Save settings
    DOM.btnSave.addEventListener('click', saveSettings);

    // Reset settings
    DOM.btnReset.addEventListener('click', async () => {
      if (confirm('Reset all settings to defaults?')) {
        const response = await sendMessage({ type: 'RESET_SETTINGS' });
        if (response?.success) {
          showToast('Settings reset ✓', 'success');
          await loadState();
        }
      }
    });
  }

  /**
   * Gather current UI state and save to background.
   */
  async function saveSettings() {
    const newSettings = {
      triggerGroup: DOM.triggerGroup.value.trim(),
      stopGroup: DOM.stopGroup.value.trim(),
      stopCommands: [...stopCommands],
      partialMatch: DOM.partialMatch.checked,
      alarmVolume: DOM.volumeSlider.value / 100,
      customAlarmSrc: currentSettings.customAlarmSrc || null,
      ignoreOwnMessages: DOM.ignoreOwn.checked,
      desktopNotifications: DOM.desktopNotif.checked,
      badgeNotifications: DOM.badgeNotif.checked,
      devLogs: DOM.devLogs.checked
    };

    const response = await sendMessage({
      type: 'SAVE_SETTINGS',
      settings: newSettings
    });

    if (response?.success) {
      showToast('Settings saved ✓', 'success');
    }
  }

  // =========================================================================
  // Listen for State Updates from Background
  // =========================================================================

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STATE_UPDATE') {
      updateUI(message.state, message.settings);
    }
  });

  // =========================================================================
  // Initialization
  // =========================================================================

  async function init() {
    initSectionToggles();
    initEventListeners();
    await loadState();
  }

  // Start
  document.addEventListener('DOMContentLoaded', init);
})();
