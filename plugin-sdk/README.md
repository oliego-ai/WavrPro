# WAVR Plugin SDK

Build VST-style audio plugins for **WAVR PRO** — pure JavaScript, zero dependencies, runs entirely in the browser.

---

## What this is

WAVR PRO is a browser-based DAW (digital audio workstation) built on the Web Audio API. This SDK lets anyone extend it with new instruments, effects, and generators without touching the DAW source code.

Plugins are plain JavaScript classes that extend `WavrPlugin`. The host (WavrPro) injects an API at mount time, and the plugin communicates back through a small set of callbacks. The React layer is a thin shell — the audio logic itself is framework-free.

---

## Package contents

```
wavr-plugin-sdk/
├── src/
│   ├── WavrPlugin.js          Base class — every plugin extends this
│   ├── PluginShell.jsx        Generic React wrapper (modal / drawer / inline)
│   └── usePluginManager.js    Registry hook for WavrPro.jsx
├── plugins/
│   └── DrumMachine/
│       └── DrumMachine.js     Full drum sequencer — reference + first-party plugin
├── examples/
│   └── ExamplePlugin.js       Minimal chord pad — start here when building a plugin
└── README.md
```

---

## Quick start

### 1. Install (if using npm)

```bash
npm install @oliego/wavr-plugin-sdk
```

Or just copy the `src/` folder into your project — there are no external dependencies.

### 2. Write a plugin

```js
// MyPlugin.js
class MyPlugin extends WavrPlugin {
  // Required static metadata
  static pluginId          = "my-plugin";
  static pluginName        = "My Plugin";
  static pluginColor       = "#6c5ce7";
  static pluginMode        = "modal";     // "modal" | "drawer" | "inline"
  static pluginCategory    = "generator"; // "instrument" | "effect" | "utility" | "generator"
  static pluginDescription = "Does something cool.";
  static pluginVersion     = "1.0.0";

  constructor(hostAPI, options = {}) {
    super(hostAPI, options);
    this._state = { /* your serialisable state */ };
  }

  // Required: build the UI
  mount(el) {
    this._el = el;
    el.innerHTML = `<button id="go">Bounce</button>`;
    el.querySelector("#go").addEventListener("click", async () => {
      const buffer = await this._renderAudio();
      this.emitBuffer(buffer);          // → drops onto a new DAW track
      this.notify("Done!", "success");
    });
  }

  // Required: clean up
  destroy() {
    // disconnect audio nodes, cancel timers
    super.destroy();  // always call last — clears el.innerHTML
  }

  // Required: state serialisation (for session save/load)
  getState()    { return { ...this._state }; }
  setState(s)   { this._state = { ...this._state, ...s }; }

  // Optional: respond to host transport
  onBpmChange(bpm)                       { super.onBpmChange(bpm); }
  onTransportStart(startBeat, ctxTime)   { /* sync your sequencer */ }
  onTransportStop()                      { /* stop your sequencer */ }
  onPlayheadTick(currentBeat)            { /* runs 60×/sec while playing */ }

  async _renderAudio() {
    const dur = this.b2s(4);           // 4 beats → seconds at host BPM
    const off = new OfflineAudioContext(1, Math.ceil(this.ctx.sampleRate * dur), this.ctx.sampleRate);
    // ... build your audio graph ...
    return off.startRendering();
  }
}
```

### 3. Register with WavrPro

Add these three things to `WavrPro.jsx`:

```jsx
// At the top of the file
import { usePluginManager } from "wavr-plugin-sdk/usePluginManager";
import PluginShell          from "wavr-plugin-sdk/PluginShell";
import MyPlugin             from "./MyPlugin";

// Inside the WavrPro component, after the existing hooks
const pluginManager = usePluginManager({
  audioCtxRef, bpmRef, tracksRef, totalBeatsRef,
  playOffsetRef, isPlayingRef,
  addTrack, setTracks, snapshot, showToast,
  s2b, uid,
});

useEffect(() => {
  pluginManager.register(MyPlugin);
}, []);

// In the topbar JSX, add a button per plugin
{pluginManager.plugins.map(p => (
  <button key={p.id} className="tlbl" onClick={() => pluginManager.toggle(p.id)}>
    ⬡ {p.name}
  </button>
))}

// Before the closing </div> of the wavr-root element
{pluginManager.plugins.filter(p => p.isOpen).map(p => (
  <PluginShell
    key={p.id}
    pluginClass={p.cls}
    hostAPI={pluginManager.getHostAPI(p.id)}
    open={p.isOpen}
    onClose={() => pluginManager.close(p.id)}
    instanceKey={p.id}
    initialState={pluginManager.pluginStates[p.id]}
  />
))}
```

---

## API reference

### WavrPlugin — base class

#### Static fields (set on your subclass)

| Field               | Type   | Required | Description                                                        |
| ------------------- | ------ | -------- | ------------------------------------------------------------------ |
| `pluginId`          | string | ✓        | Unique identifier, e.g. `"my-plugin"`. Used as the registry key.   |
| `pluginName`        | string | ✓        | Display name shown in the DAW topbar button.                       |
| `pluginColor`       | string | ✓        | CSS hex accent colour for the plugin chrome.                       |
| `pluginMode`        | string |          | Default UI chrome: `"modal"` (default), `"drawer"`, or `"inline"`. |
| `pluginCategory`    | string |          | `"instrument"` \| `"effect"` \| `"utility"` \| `"generator"`       |
| `pluginDescription` | string |          | One-line description for the plugin browser.                       |
| `pluginVersion`     | string |          | SemVer version string.                                             |

#### Properties (injected by host — do not override)

| Property       | Type         | Description                                           |
| -------------- | ------------ | ----------------------------------------------------- |
| `this.host`    | HostAPI      | Full host API object.                                 |
| `this.ctx`     | AudioContext | The DAW's shared `AudioContext`. **Do not close it.** |
| `this.bpm`     | number       | Current host BPM. Updated by `onBpmChange()`.         |
| `this.options` | object       | Options passed through from `PluginShell`.            |

#### Methods to implement

```js
mount(el: HTMLElement): void         // Required — build UI into el
destroy(): void                      // Required — clean up; call super.destroy() last
getState(): object                   // Required — return JSON-serialisable state
setState(state: object): void        // Required — restore state; called on re-open
```

#### Transport hooks (optional)

```js
onBpmChange(bpm: number): void
onTransportStart(startBeat: number, contextTime: number): void
onTransportStop(): void
onPlayheadTick(currentBeat: number): void   // runs 60×/sec — keep it cheap
```

#### Helpers (call these; never override)

```js
this.emitBuffer(buffer: AudioBuffer, label?: string): void
// → Sends a rendered buffer to the host to place on a new track.
//   Equivalent to hitting "Bounce" in a real DAW plugin.

this.emitStateChange(): void
// → Marks the session dirty so the user is prompted to save.
//   Call this whenever your internal state changes.

this.notify(message: string, level?: "info"|"success"|"warn"|"error"): void
// → Displays a toast notification in the DAW UI.

this.b2s(beats: number): number   // beats → seconds at current BPM
this.s2b(seconds: number): number // seconds → beats at current BPM
```

---

### HostAPI — what the host provides

Your plugin receives this object as `hostAPI` in the constructor (accessible via `this.host`).

```ts
interface HostAPI {
  readonly audioContext: AudioContext
  readonly bpm: number

  onRender(buffer: AudioBuffer, bpm: number, label?: string): void
  onStateChange(state: object): void
  onNotify(message: string, level: string): void

  addTrack(name: string, color?: string): Track
  getPlayhead(): { beat: number, isPlaying: boolean, contextTime: number }
  getTracks(): TrackSummary[]
}
```

You should almost never need to call `this.host.*` directly. Use the provided helpers (`emitBuffer`, `emitStateChange`, `notify`) instead.

---

### PluginShell — React wrapper

```jsx
<PluginShell
  pluginClass={MyPlugin}         // WavrPlugin subclass
  hostAPI={hostAPI}              // from usePluginManager.getHostAPI(id)
  open={boolean}
  onClose={() => {}}
  mode="modal"                   // "modal" | "drawer" | "inline"
  options={{}}                   // passed to plugin constructor
  initialState={savedState}      // from pluginManager.pluginStates[id]
  instanceKey="my-plugin"        // enables state persistence across open/close
/>
```

---

### usePluginManager — registry hook

```js
const {
  plugins,              // registered plugin descriptors (array)
  pluginStates,         // persisted state map { [pluginId]: state }

  register(cls, overrides?),    // add a plugin to the registry
  unregister(id),               // remove a plugin

  open(id),    close(id),  toggle(id),   // control visibility

  getHostAPI(pluginId),   // construct a HostAPI for a given plugin

  notifyTransportStart(beat, ctxTime),  // call from startPlayback()
  notifyTransportStop(),                // call from stopPlayback()
  notifyPlayheadTick(beat),             // call from rAF animLoop
  notifyBpmChange(bpm),                 // call when BPM input changes

  restoreAllStates(states),  // call from applySession() when loading
} = usePluginManager({ audioCtxRef, bpmRef, ... });
```

---

## Session integration

Plugin states are automatically saved with the session when you include them in `saveSession` and restored in `applySession`:

```js
// In saveSession():
const data = {
  // ... existing session fields ...
  pluginStates: pluginManager.pluginStates,
};

// In applySession(data):
if (data.pluginStates) {
  pluginManager.restoreAllStates(data.pluginStates);
}
```

---

## Transport sync

To keep plugins in sync with the DAW transport, call the broadcasting methods at the right points in WavrPro:

```js
// In startPlayback():
pluginManager.notifyTransportStart(playOffsetRef.current, ctx.currentTime);

// In stopPlayback():
pluginManager.notifyTransportStop();

// In the rAF animLoop (only add this if plugins need tick events):
pluginManager.notifyPlayheadTick(currentBeat());

// When BPM input changes:
pluginManager.notifyBpmChange(bpm);
```

---

## Standalone usage (no React)

Plugins work perfectly without React. Use them anywhere:

```html
<!-- Plain HTML — no bundler needed -->
<script src="src/WavrPlugin.js"></script>
<script src="plugins/DrumMachine/DrumMachine.js"></script>

<div id="plugin-host"></div>
<script>
  const ctx = new AudioContext();
  const dm  = new DrumMachine({ audioContext: ctx, bpm: 120 });

  dm.onRender = (buffer, bpm) => {
    console.log("Got", buffer.duration.toFixed(2), "s of audio at", bpm, "BPM");
  };

  dm.mount(document.getElementById("plugin-host"));
</script>
```

---

## Included plugins

### DrumMachine

A full 16/32-step drum sequencer with 8 synthesized instruments.

```js
import DrumMachine from "wavr-plugin-sdk/plugins/DrumMachine";

// Plugin framework usage (recommended)
pluginManager.register(DrumMachine);

// Standalone usage (legacy / non-React)
const dm = new DrumMachine({ audioContext: ctx, bpm: 120 });
dm.mount(document.getElementById("host"));
dm.onRender        = (buf, bpm) => { /* handle bounced audio */ };
dm.onPatternChange = (pattern)  => { /* pattern changed */ };
dm.onStepTick      = (step)     => { /* called every 16th note */ };
```

**Instruments:** Kick, Snare, Clap, HH Closed, HH Open, Tom Hi, Tom Mid, Ride

**Features:** 16/32 steps · swing (0–75%) · per-step velocity · per-instrument volume · mute/solo · 4 genre presets · randomize · bounce to AudioBuffer

---

## Writing a plugin: checklist

- [ ] Extend `WavrPlugin`
- [ ] Set all required static fields (`pluginId`, `pluginName`, `pluginColor`)
- [ ] Implement `mount(el)` — render UI into `el`, store as `this._el`
- [ ] Implement `destroy()` — disconnect audio, cancel timers, call `super.destroy()` last
- [ ] Implement `getState()` — return plain JSON-serialisable object
- [ ] Implement `setState(s)` — restore from that object (called on re-open and session load)
- [ ] Use `this.ctx` for the AudioContext (never create your own)
- [ ] Use `this.emitBuffer(buf)` to send audio to the DAW timeline
- [ ] Use `this.emitStateChange()` when internal state changes
- [ ] Use `this.notify(msg, level)` for user-visible status messages
- [ ] Use `this.b2s(beats)` / `this.s2b(seconds)` for time conversion
- [ ] Override `onBpmChange(bpm)` and call `super.onBpmChange(bpm)` if BPM matters to your plugin
- [ ] Scope all CSS class names with a plugin-specific prefix to avoid collisions

---

## Style guide for plugin UIs

Plugins render inside the WAVR PRO dark theme. Use these CSS variables inside your plugin DOM to stay consistent:

```css
/* Copy these into your plugin's injected <style> block */
:root {
  --wavr-bg:      #100c09;    /* page background */
  --wavr-sf:      #1a1410;    /* surface */
  --wavr-sf2:     #221c17;    /* surface raised */
  --wavr-sf3:     #2b2219;    /* surface hover */
  --wavr-tx:      #f0e8e2;    /* primary text */
  --wavr-mt:      #7a6a60;    /* muted text */
  --wavr-ac:      #ff6b35;    /* host accent (ember) */
  --wavr-br:      rgba(255,107,53,.1);   /* border */
  --wavr-br2:     rgba(255,107,53,.22);  /* emphasis border */
}
```

Prefix all your CSS class names with your `pluginId` (e.g. `.my-plugin-btn`) to avoid collisions with other plugins or the DAW itself.

---

## Licence

MIT — use freely in open-source and commercial projects.
