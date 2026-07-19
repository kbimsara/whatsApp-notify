/**
 * options.js — Options Page Controller
 * 
 * Full-page settings interface for the WhatsApp Alert System.
 * Same functionality as popup.js, adapted for the expanded layout.
 */

(() => {
  'use strict';

  // =========================================================================
  // DOM References
  // =========================================================================

  const $ = (sel) => document.querySelector(sel);

  const DOM = {
    statusDot: $('#statusDot'),
    statusLabel: $('#statusLabel'),

    monitoringCard: $('#monitoringCard'),
    alarmCard: $('#alarmCard'),
    monitoringStatus: $('#monitoringStatus'),
    alarmStatus: $('#alarmStatus'),
    lastTriggerTime: $('#lastTriggerTime'),
    lastStopTime: $('#lastStopTime'),

    triggerGroup: $('#triggerGroup'),
    stopGroup: $('#stopGroup'),
    btnEnable: $('#btnEnable'),
    btnDisable: $('#btnDisable'),
    btnStopAlarm: $('#btnStopAlarm'),

    stopCommandTags: $('#stopCommandTags'),
    newStopCommand: $('#newStopCommand'),
    btnAddCommand: $('#btnAddCommand'),
    partialMatch: $('#partialMatch'),

    volumeSlider: $('#volumeSlider'),
    volumeValue: $('#volumeValue'),
    btnTestAlarm: $('#btnTestAlarm'),
    btnStopTest: $('#btnStopTest'),
    customAlarmFile: $('#customAlarmFile'),
    btnRestoreDefault: $('#btnRestoreDefault'),
    customAlarmName: $('#customAlarmName'),

    ignoreOwn: $('#ignoreOwn'),
    desktopNotif: $('#desktopNotif'),
    badgeNotif: $('#badgeNotif'),
    devLogs: $('#devLogs'),

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
  // Toast
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
  // UI Updates
  // =========================================================================

  function updateUI(state, settings) {
    currentState = state || currentState;
    currentSettings = settings || currentSettings;

    // Status
    if (currentState.alarmActive) {
      DOM.statusDot.className = 'status-dot alarm';
      DOM.statusLabel.textContent = 'ALARM ACTIVE';
    } else if (currentState.monitoringEnabled) {
      DOM.statusDot.className = 'status-dot active';
      DOM.statusLabel.textContent = 'Monitoring';
    } else {
      DOM.statusDot.className = 'status-dot';
      DOM.statusLabel.textContent = 'Inactive';
    }

    // Status cards
    DOM.monitoringCard.className = currentState.monitoringEnabled ? 'status-card active' : 'status-card';
    DOM.monitoringStatus.textContent = currentState.monitoringEnabled ? 'Active' : 'Inactive';
    DOM.monitoringStatus.style.color = currentState.monitoringEnabled ? 'var(--success)' : '';

    DOM.alarmCard.className = currentState.alarmActive ? 'status-card alarm' : 'status-card';
    DOM.alarmStatus.textContent = currentState.alarmActive ? '🔔 ACTIVE' : 'Silent';
    DOM.alarmStatus.style.color = currentState.alarmActive ? 'var(--danger)' : '';

    // Times
    DOM.lastTriggerTime.textContent = currentState.lastTriggerTime ? formatTime(currentState.lastTriggerTime) : '—';
    DOM.lastStopTime.textContent = currentState.lastStopTime ? formatTime(currentState.lastStopTime) : '—';

    // Enable/disable buttons
    DOM.btnEnable.style.display = currentState.monitoringEnabled ? 'none' : '';
    DOM.btnDisable.style.display = currentState.monitoringEnabled ? '' : 'none';
    DOM.btnStopAlarm.style.display = currentState.alarmActive ? '' : 'none';

    // Form fields
    if (document.activeElement !== DOM.triggerGroup) DOM.triggerGroup.value = currentSettings.triggerGroup || '';
    if (document.activeElement !== DOM.stopGroup) DOM.stopGroup.value = currentSettings.stopGroup || '';

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

    // Custom alarm
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
      if (diff < 60000) return 'Just now';
      if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return isoString;
    }
  }

  // =========================================================================
  // Communication
  // =========================================================================

  async function sendMessage(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
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
    DOM.btnEnable.addEventListener('click', async () => {
      const triggerGroup = DOM.triggerGroup.value.trim();
      const stopGroup = DOM.stopGroup.value.trim();
      if (!triggerGroup) { showToast('Enter a Trigger Group name', 'error'); return; }
      if (!stopGroup) { showToast('Enter a Stop Group name', 'error'); return; }
      await saveSettings();
      const response = await sendMessage({ type: 'ENABLE_MONITORING' });
      if (response?.success) { showToast('Monitoring enabled ✓', 'success'); await loadState(); }
    });

    DOM.btnDisable.addEventListener('click', async () => {
      const response = await sendMessage({ type: 'DISABLE_MONITORING' });
      if (response?.success) { showToast('Monitoring disabled', 'info'); await loadState(); }
    });

    DOM.btnStopAlarm.addEventListener('click', async () => {
      const response = await sendMessage({ type: 'MANUAL_STOP_ALARM' });
      if (response?.success) { showToast('Alarm stopped ✓', 'success'); await loadState(); }
    });

    DOM.btnAddCommand.addEventListener('click', addStopCommand);
    DOM.newStopCommand.addEventListener('keypress', (e) => { if (e.key === 'Enter') addStopCommand(); });

    DOM.volumeSlider.addEventListener('input', () => {
      DOM.volumeValue.textContent = `${DOM.volumeSlider.value}%`;
    });

    DOM.btnTestAlarm.addEventListener('click', async () => {
      const response = await sendMessage({ type: 'TEST_ALARM' });
      if (response?.success) {
        isTestPlaying = true;
        DOM.btnTestAlarm.style.display = 'none';
        DOM.btnStopTest.style.display = '';
        showToast('Testing alarm (3s)', 'info');
        setTimeout(() => { isTestPlaying = false; DOM.btnTestAlarm.style.display = ''; DOM.btnStopTest.style.display = 'none'; }, 3000);
      }
    });

    DOM.btnStopTest.addEventListener('click', async () => {
      await sendMessage({ type: 'STOP_TEST_ALARM' });
      isTestPlaying = false;
      DOM.btnTestAlarm.style.display = '';
      DOM.btnStopTest.style.display = 'none';
    });

    DOM.customAlarmFile.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { showToast('File too large (max 5MB)', 'error'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        currentSettings.customAlarmSrc = reader.result;
        DOM.customAlarmName.textContent = `✓ ${file.name}`;
        DOM.customAlarmName.style.color = 'var(--success)';
        showToast(`Loaded: ${file.name}`, 'success');
      };
      reader.readAsDataURL(file);
    });

    DOM.btnRestoreDefault.addEventListener('click', () => {
      currentSettings.customAlarmSrc = null;
      DOM.customAlarmName.textContent = 'Using default alarm sound';
      DOM.customAlarmName.style.color = '';
      showToast('Default alarm restored', 'info');
    });

    DOM.btnSave.addEventListener('click', saveSettings);

    DOM.btnReset.addEventListener('click', async () => {
      if (confirm('Reset all settings to defaults?')) {
        const response = await sendMessage({ type: 'RESET_SETTINGS' });
        if (response?.success) { showToast('Settings reset ✓', 'success'); await loadState(); }
      }
    });
  }

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

    const response = await sendMessage({ type: 'SAVE_SETTINGS', settings: newSettings });
    if (response?.success) { showToast('Settings saved ✓', 'success'); }
  }

  // =========================================================================
  // Listen for Updates
  // =========================================================================

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STATE_UPDATE') {
      updateUI(message.state, message.settings);
    }
  });

  // =========================================================================
  // Init
  // =========================================================================

  document.addEventListener('DOMContentLoaded', async () => {
    initEventListeners();
    await loadState();
  });
})();
