# 🔔 WhatsApp Web Alert System — Chrome Extension

A production-ready Chrome Extension (Manifest V3) that continuously monitors a configurable WhatsApp group for new messages and plays a loud alarm buzzer. The alarm keeps playing until a configurable stop command is received in a designated stop group.

**Everything runs locally. No external servers. No data collection. No telemetry.**

---

## 🚀 Features

- **Trigger Group Monitoring** — Detects new messages in your configured trigger group
- **Stop Group Control** — Stops the alarm only when a matching stop command is received
- **Multiple Stop Commands** — Configure unlimited stop keywords with case-insensitive matching
- **Continuous Alarm** — Loud buzzer loops indefinitely until explicitly stopped
- **Sidebar Detection** — Monitors unread indicators even when the trigger group isn't the active chat
- **Custom Alarm Sounds** — Upload your own MP3 or use the built-in buzzer
- **Volume Control** — Adjustable alarm volume with live preview
- **Desktop Notifications** — System notifications on alarm trigger and stop
- **Badge Indicators** — Color-coded badge: Gray (disabled), Green (monitoring), Red (alarm active)
- **Modern Dark UI** — Glassmorphism design with smooth animations
- **Zero Data Collection** — Everything stays on your machine

---

## 📋 How It Works

```
New message in "🚨 Production Alerts"
        ↓
   Alarm starts
        ↓
  Alarm keeps playing
        ↓
Someone sends "STOP" in "🛠 Operations Team"
        ↓
  Alarm immediately stops
```

### Trigger & Stop Flow

| Event | Group | Message | Result |
|-------|-------|---------|--------|
| New message | 🚨 Production Alerts | "Server Down" | ⚠️ Alarm Starts |
| New message | 🛠 Operations Team | "Checking" | 🔔 Alarm Continues |
| New message | 🛠 Operations Team | "Resolved" | ✅ Alarm Stops |

---

## 🛠 Installation

### Prerequisites
- Google Chrome (version 116 or later)
- Node.js (only needed for generating icons)

### Steps

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/whatsApp-notify.git
   cd whatsApp-notify
   ```

2. **Generate extension icons**
   ```bash
   node generate-icons.js
   ```

3. **Load in Chrome**
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable **Developer mode** (toggle in top-right corner)
   - Click **Load unpacked**
   - Select the `whatsApp-notify` folder

4. **Open WhatsApp Web**
   - Go to [https://web.whatsapp.com](https://web.whatsapp.com)
   - Scan the QR code to log in

5. **Configure the extension**
   - Click the extension icon in Chrome's toolbar
   - Enter your **Trigger Group** name (e.g., `🚨 Production Alerts`)
   - Enter your **Stop Group** name (e.g., `🛠 Operations Team`)
   - Click **Save Settings**
   - Click **Enable Monitoring**

---

## ⚙️ Configuration

### Monitoring Settings
| Setting | Description |
|---------|-------------|
| Trigger Group Name | The WhatsApp group that triggers the alarm |
| Stop Group Name | The WhatsApp group where stop commands are sent |

### Stop Commands
Default stop commands: `STOP`, `stop`, `Resolved`, `Issue Fixed`, `BUZZER STOP`, `ALARM OFF`, `#stop`, `Emergency Cleared`

- **Case insensitive** — "STOP", "stop", "Stop" all match
- **Whitespace trimmed** — Leading/trailing spaces are ignored
- **Partial match** — "Issue Resolved ✔" matches keyword "Resolved" (when partial match is ON)
- **Fully configurable** — Add or remove keywords in the popup

### Alarm Settings
| Setting | Description |
|---------|-------------|
| Volume Slider | 0% – 100% volume control |
| Test Alarm | Play a 3-second alarm preview |
| Upload Custom MP3 | Replace the default buzzer with your own sound (max 5MB) |
| Restore Default | Reset to the built-in buzzer tone |

### Advanced Settings
| Setting | Default | Description |
|---------|---------|-------------|
| Ignore Own Messages | ✅ ON | Don't trigger alarm from your own messages |
| Desktop Notifications | ✅ ON | Show system notifications on trigger/stop |
| Badge Notifications | ✅ ON | Color-coded badge on extension icon |
| Developer Logs | ❌ OFF | Console logging for debugging |

---

## 🏗 Architecture

```
whatsApp-notify/
├── manifest.json          # Chrome Extension manifest (V3)
├── background.js          # Service worker — state management & alarm control
├── content.js             # Content script — DOM observation on WhatsApp Web
├── popup.html/css/js      # Extension popup UI
├── options.html/css/js    # Full-page options panel
├── offscreen.html/js      # Offscreen document for audio playback
├── audio/                 # Alarm sound files
├── icons/                 # Extension icons (16/32/48/128px)
├── generate-icons.js      # Icon generation script
└── README.md
```

### Component Communication

```
┌─────────────────┐     messages      ┌──────────────────┐
│   Content Script │ ───────────────→  │  Background (SW)  │
│  (WhatsApp Web)  │ ←─────────────── │  State Manager    │
└─────────────────┘                   └──────────────────┘
                                            │       ↑
                                            │       │
                                    ┌───────↓───────┤
                                    │               │
                              ┌─────↓─────┐  ┌─────┴─────┐
                              │  Offscreen │  │   Popup /  │
                              │   Audio    │  │  Options   │
                              └───────────┘  └───────────┘
```

### Content Script
- Runs on `https://web.whatsapp.com/*`
- Uses `MutationObserver` (no polling) for DOM monitoring
- Observes both the active chat and sidebar unread indicators
- Deduplicates messages using a processed-ID set
- Waits 3 seconds after injection before processing (skip initial DOM load)

### Background Service Worker
- Manages monitoring and alarm state
- Routes trigger/stop events from content script
- Controls the offscreen document for audio
- Updates badge and sends notifications
- Persists state across service worker restarts

### Offscreen Audio
- Chrome Offscreen Document API for background audio playback
- Generates a synthetic buzzer tone using Web Audio API
- Supports custom MP3 via base64 data URLs

---

## 🔒 Privacy

- ✅ **100% local** — No data ever leaves your browser
- ✅ **No external servers** — No API calls, no cloud services
- ✅ **No analytics** — No tracking, no telemetry
- ✅ **No data storage** — Only settings are stored (in Chrome sync storage)
- ✅ **Open source** — Fully auditable code

---

## 🐛 Troubleshooting

### Alarm doesn't trigger
1. Ensure the Trigger Group name matches **exactly** (including emojis)
2. Check that monitoring is enabled (badge should be green)
3. Open the trigger group chat — sidebar detection works but has limitations
4. Enable Developer Logs and check the browser console

### Alarm doesn't stop
1. Ensure the Stop Group name matches exactly
2. Navigate to the Stop Group chat in WhatsApp Web
3. Check that your stop command matches a configured keyword
4. Use the **Stop Alarm** button in the popup as a manual override

### Extension not loading
1. Ensure you're on Chrome 116+ with Manifest V3 support
2. Check `chrome://extensions/` for errors
3. Try removing and re-loading the extension

### Audio not playing
1. Check Chrome's site settings for sound permissions
2. Ensure volume slider is above 0%
3. Use the **Test Alarm** button to verify
4. Try restoring the default alarm sound

---

## 📝 License

MIT License — see [LICENSE](LICENSE) for details.

---

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

> **Built with ❤️ for DevOps teams who need immediate awareness of production incidents.**
