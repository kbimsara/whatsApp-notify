/**
 * offscreen.js — Offscreen Audio Controller
 * 
 * Handles alarm audio playback in a Chrome Offscreen Document.
 * Receives commands from the background service worker via chrome.runtime.onMessage.
 * 
 * Supported commands:
 *   PLAY_ALARM   — Start playing alarm audio in a loop
 *   STOP_ALARM   — Stop and reset alarm audio
 *   SET_VOLUME   — Adjust alarm volume (0.0 – 1.0)
 *   SET_SOURCE   — Change alarm audio source (base64 data URL or file path)
 *   GET_STATUS   — Return current playback status
 */

(() => {
  'use strict';

  const audioEl = document.getElementById('alarm-audio');
  
  // Default alarm: a synthetic buzzer encoded as base64 WAV
  // This is generated at build time — a loud repeating buzzer tone
  let defaultAlarmSrc = null;
  let customAlarmSrc = null;
  let isPlaying = false;

  /**
   * Generate a synthetic alarm buzzer using Web Audio API.
   * Creates a WAV blob URL with a repeating alarm pattern.
   */
  function generateDefaultAlarm() {
    const sampleRate = 44100;
    const duration = 2; // 2-second pattern that loops
    const numSamples = sampleRate * duration;
    const buffer = new Float32Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      // Create an alternating two-tone alarm pattern
      // Tone 1: 800Hz for 0.25s, Tone 2: 600Hz for 0.25s, repeat
      const cyclePos = t % 0.5;
      const freq = cyclePos < 0.25 ? 800 : 600;
      
      // Generate square-ish wave for harsh buzzer sound
      const sine = Math.sin(2 * Math.PI * freq * t);
      const harmonic2 = Math.sin(2 * Math.PI * freq * 2 * t) * 0.5;
      const harmonic3 = Math.sin(2 * Math.PI * freq * 3 * t) * 0.3;
      
      // Envelope: slight attack/release per cycle to avoid clicks
      const envCyclePos = t % 0.25;
      const attack = Math.min(envCyclePos / 0.01, 1.0);
      const release = Math.min((0.25 - envCyclePos) / 0.01, 1.0);
      const envelope = Math.min(attack, release);
      
      buffer[i] = (sine + harmonic2 + harmonic3) * 0.7 * envelope;
      // Clip to [-1, 1]
      buffer[i] = Math.max(-1, Math.min(1, buffer[i]));
    }

    // Encode as WAV
    const wavBlob = encodeWAV(buffer, sampleRate);
    defaultAlarmSrc = URL.createObjectURL(wavBlob);
    return defaultAlarmSrc;
  }

  /**
   * Encode a Float32Array of samples into a WAV Blob.
   */
  function encodeWAV(samples, sampleRate) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = samples.length * (bitsPerSample / 8);
    const headerSize = 44;
    const totalSize = headerSize + dataSize;

    const arrayBuffer = new ArrayBuffer(totalSize);
    const view = new DataView(arrayBuffer);

    // RIFF header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, totalSize - 8, true);
    writeString(view, 8, 'WAVE');

    // fmt chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // chunk size
    view.setUint16(20, 1, true);  // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);

    // data chunk
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Write samples
    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
      view.setInt16(offset, val, true);
      offset += 2;
    }

    return new Blob([arrayBuffer], { type: 'audio/wav' });
  }

  function writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  /**
   * Start playing the alarm in a continuous loop.
   */
  function playAlarm(volume = 1.0) {
    if (isPlaying) return; // Prevent duplicate instances
    
    const src = customAlarmSrc || defaultAlarmSrc || generateDefaultAlarm();
    audioEl.src = src;
    audioEl.loop = true;
    audioEl.volume = Math.max(0, Math.min(1, volume));
    
    audioEl.play()
      .then(() => {
        isPlaying = true;
        console.log('[Offscreen] Alarm started playing');
      })
      .catch(err => {
        console.error('[Offscreen] Failed to play alarm:', err);
      });
  }

  /**
   * Stop the alarm immediately.
   */
  function stopAlarm() {
    audioEl.pause();
    audioEl.currentTime = 0;
    isPlaying = false;
    console.log('[Offscreen] Alarm stopped');
  }

  /**
   * Set the alarm volume.
   */
  function setVolume(volume) {
    audioEl.volume = Math.max(0, Math.min(1, volume));
    console.log('[Offscreen] Volume set to', audioEl.volume);
  }

  /**
   * Set a custom alarm audio source.
   * @param {string} src - Base64 data URL or blob URL
   */
  function setSource(src) {
    if (src === '__default__') {
      customAlarmSrc = null;
      if (isPlaying) {
        stopAlarm();
        playAlarm(audioEl.volume);
      }
      console.log('[Offscreen] Restored default alarm');
    } else {
      customAlarmSrc = src;
      if (isPlaying) {
        // Restart with new source
        stopAlarm();
        playAlarm(audioEl.volume);
      }
      console.log('[Offscreen] Custom alarm source set');
    }
  }

  // Initialize default alarm on load
  generateDefaultAlarm();

  /**
   * Listen for commands from the background service worker.
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'offscreen') return;

    switch (message.command) {
      case 'PLAY_ALARM':
        playAlarm(message.volume ?? 1.0);
        sendResponse({ success: true, playing: true });
        break;

      case 'STOP_ALARM':
        stopAlarm();
        sendResponse({ success: true, playing: false });
        break;

      case 'SET_VOLUME':
        setVolume(message.volume ?? 1.0);
        sendResponse({ success: true, volume: audioEl.volume });
        break;

      case 'SET_SOURCE':
        setSource(message.src);
        sendResponse({ success: true });
        break;

      case 'GET_STATUS':
        sendResponse({
          success: true,
          playing: isPlaying,
          volume: audioEl.volume,
          hasCustomSource: !!customAlarmSrc
        });
        break;

      default:
        sendResponse({ success: false, error: 'Unknown command' });
    }

    return true; // Keep channel open for async response
  });

  console.log('[Offscreen] Audio controller initialized');
})();
