# WAVR PRO

> A full-featured digital audio workstation that runs entirely in your browser.  
> Multi-track timeline · 6-band EQ · Session save · WAV export · VST-style plugin system · Zero install.

**[→ Launch the DAW](docs/wavr-demo.html)** · **[→ Plugin SDK](docs/sdk-index.html)** · **[→ Live Drum Machine Demo](docs/sdk-demo.html)**

---

## What is WAVR PRO?

WAVR PRO is a browser DAW built on React and the Web Audio API. It runs entirely client-side — your audio never leaves your machine, no account required, no server roundtrip for anything.

It ships with a complete recording and mixing workflow, a project template system, a full-featured drum machine, and an extensible plugin SDK that lets anyone add new instruments and effects without touching the core.

---

## Repository structure

```
wavr-pro/
├── src/
│   ├── WavrPro.jsx              Main React DAW component (~1500 lines)
│   └── wavr-ember-theme.css     Drop-in ember orange colour theme
│
├── plugins/
│   └── DrumMachine/
│       ├── DrumMachine.js       Pure JS drum sequencer (standalone)
│       ├── DrumMachinePlugin.jsx React wrapper for WavrPro
│       └── test.html            Self-contained test harness
│
├── plugin-sdk/                  The WAVR Plugin SDK (standalone package)
│   ├── src/
│   │   ├── WavrPlugin.js        Base class all plugins extend
│   │   ├── PluginShell.jsx      Generic React modal/drawer wrapper
│   │   └── usePluginManager.js  Registry hook for WavrPro
│   ├── plugins/DrumMachine/     SDK-migrated drum machine
│   ├── examples/ExamplePlugin.js Minimal chord pad reference
│   ├── package.json
│   └── README.md                Full SDK API documentation
│
├── public/
│   ├── wavr-pro.html            Standalone full build (no server needed)
│   └── wavr-lite.html           Standalone lite build
│
├── docs/                        GitHub Pages site
│   ├── index.html               WAVR PRO landing page
│   ├── wavr-demo.html           WAVR PRO live demo wrapper
│   ├── sdk-index.html           Plugin SDK landing page
│   └── sdk-demo.html            Drum Machine live demo
│
├── README.md                    This file
├── CONTRIBUTING.md              How to contribute
└── COMMUNITY.md                 Plugin authors guide (public-facing)
```

---

## Quick start

### Option A — open the standalone build

No install, no server, no build step:

1. Download `public/wavr-pro.html`
2. Open it in Chrome, Firefox, Safari, or Edge
3. Drag audio files from your OS onto the timeline lanes
4. Press Space to play

### Option B — React integration

```bash
# Clone the repo
git clone http://github.com/oliego-ai/WavrPro
cd wavr-pro

# No npm install needed — WavrPro.jsx has zero runtime dependencies
# Just import it directly into your React project:
```

```jsx
// In your app
import WavrPro from './src/WavrPro';

export default function App() {
  return <WavrPro />;
}
```

WavrPro is a self-contained React component. It manages its own state, audio context, IndexedDB sessions, and plugin registry. Drop it anywhere.

### Adding the Drum Machine plugin

```jsx
import { usePluginManager } from './plugin-sdk/src/usePluginManager';
import PluginShell          from './plugin-sdk/src/PluginShell';
import DrumMachine          from './plugins/DrumMachine/DrumMachine';

// Inside WavrPro.jsx, after the existing hooks:
const pluginManager = usePluginManager({ audioCtxRef, bpmRef, /* ... */ });

useEffect(() => {
  pluginManager.register(DrumMachine);
}, []);
```

See `CONTRIBUTING.md` for the full integration guide and `plugin-sdk/README.md` for the complete SDK API.

---

## Feature overview

### Timeline

- Unlimited tracks with drag-and-drop audio clips
- Drag to move clips, resize from the right edge, right-click for context menu
- Click the ruler or drag the playhead to seek anywhere
- Mute, Solo, Arm, and per-track volume controls

### Mixing

- **6-band parametric EQ per track** — SUB (lowshelf 60Hz), BASS (200Hz), LO-MID (600Hz), MID (1800Hz), HI-MID (5000Hz), AIR (highshelf 12kHz)
- **Five visualizer modes** — waveform, spectrum, spectrogram, oscilloscope, VU meter
- Master gain with clipping protection

### Transport

- Play, pause in place, stop, rewind
- Drag the playhead to any position — audio restarts from that beat
- Space bar to play/pause, Home to rewind

### Session & Export

- Named sessions stored in IndexedDB — survive browser refresh
- Autosave every 60 seconds
- 40-step undo/redo history with labeled action names
- Export/import `.wavrproj` files (self-contained JSON with embedded PCM)
- Full mix WAV export — 44.1kHz 16-bit stereo via `OfflineAudioContext`

### Templates

Six synthesized starter sessions (no audio files needed):

- Blank, Lo-Fi Hip Hop (87 BPM, swing), Techno (138 BPM), Ambient (70 BPM), Pop (120 BPM), Podcast/VO

### Plugin system

- Register any `WavrPlugin` subclass with one line
- Automatically gets topbar button, modal/drawer chrome, BPM sync, and session state
- `PluginShell.jsx` is a generic wrapper that works for every plugin
- Included: **Drum Machine** (16/32-step sequencer, 8 synthesized instruments)

---

## Browser compatibility

| Browser     | Status          |
| ----------- | --------------- |
| Chrome 90+  | ✅ Full support |
| Firefox 88+ | ✅ Full support |
| Safari 15+  | ✅ Full support |
| Edge 90+    | ✅ Full support |

### Known limitations

| Limitation                       | Why                                                                |
| -------------------------------- | ------------------------------------------------------------------ |
| No native VST/AU                 | Web platform only. Plugins are JS classes, not binaries.           |
| No MIDI input (yet)              | Web MIDI API not yet integrated.                                   |
| Audio pauses when tab is hidden  | Browser AudioContext throttling — unfocused tabs suspend.          |
| Session storage is browser-local | IndexedDB is per-browser-profile. Use `.wavrproj` export to share. |

---

## Architecture notes

**React manages UI state. Web Audio manages everything audio.**

The key principle: anything on the audio timing path (scheduling, gain changes, analyser reads) uses `useRef` and the Web Audio API directly. React `useState` only updates when the UI needs to re-render. This keeps the 60fps audio loop completely independent of React's render cycle.

Key patterns:

- `tracksRef` mirrors `tracks` state for audio callbacks that would otherwise capture stale closures
- VU meters write directly to DOM via `vuFillsRef` — never via setState
- `playOffsetRef` and `playStartRef` are refs, not state — the scheduler reads them directly
- EQ nodes are live-patched: `handleEQChange` updates `f.gain.value` on the existing BiquadFilterNode without rebuilding the chain

The `.wavrproj` format stores raw PCM float arrays directly in JSON via `bufferToRaw()` / `rawToBuffer()`. Files can be 30–80 MB for real audio; synthesized clips are tiny. This sidesteps all CORS and encoding issues.

---

## The Plugin SDK

The `plugin-sdk/` directory is a standalone package. Full documentation is in `plugin-sdk/README.md` and the public-facing community guide is in `COMMUNITY.md`.

The short version:

```js
class MyPlugin extends WavrPlugin {
  static pluginId   = "my-plugin";
  static pluginName = "My Plugin";
  static pluginColor = "#6c5ce7";

  mount(el)    { /* build UI */ }
  destroy()    { super.destroy(); }
  getState()   { return {}; }
  setState(s)  { }
}
```

Register it once in WavrPro and the framework handles everything else.

---

## Contributing

See `CONTRIBUTING.md` for the full guide. Short version:

- Bug fixes and improvements to `WavrPro.jsx` → open a PR with a description of the audio or UI problem fixed
- New plugins → follow the guide in `COMMUNITY.md`, include a test page
- SDK improvements → open an issue first to discuss the API change

---

## Licence

MIT — use freely in open-source and commercial projects.
