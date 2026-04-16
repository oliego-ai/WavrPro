# WAVR Plugin SDK

> Build instruments, effects, and generators for **WAVR PRO** — the open browser DAW.  
> Pure JavaScript. Zero dependencies. No build step required.

---

## What is this?

WAVR PRO is a browser-based DAW built on the Web Audio API. The plugin SDK lets the community extend it with new instruments, effects, and creative tools — without touching the DAW source code.

Plugins are self-contained JavaScript classes. You write the audio logic and the UI. WAVR handles the chrome, the session save/load, transport sync, and dropping your rendered audio onto a track. The two sides communicate through a small, stable contract that won't change under you.

**You don't need React, a bundler, or a server.** A plugin is a single `.js` file.

---

## What plugins can do

- Generate audio and **bounce it directly onto a DAW track** with one method call
- **Sync to the host transport** — know the current BPM, respond when playback starts or stops
- **Persist state** with the session — your plugin's knob positions survive save/load/reopen
- **Show toast notifications** in the DAW UI
- Read the current track list and create new tracks
- Render in a **modal**, **bottom drawer**, or **inline** panel — your choice

---

## Getting started

### Option A — copy the template

The fastest path. Grab `examples/ExamplePlugin.js`, rename everything, and start building.

### Option B — extend the base class

```js
class MyPlugin extends WavrPlugin {

  // ── Identity ─────────────────────────────────────────────────
  static pluginId          = "my-plugin";       // unique, snake-case
  static pluginName        = "My Plugin";       // shown in the DAW topbar
  static pluginColor       = "#6c5ce7";         // accent colour (CSS hex)
  static pluginMode        = "modal";           // "modal" | "drawer" | "inline"
  static pluginCategory    = "instrument";      // instrument | effect | utility | generator
  static pluginDescription = "Does something cool.";
  static pluginVersion     = "1.0.0";

  constructor(hostAPI, options = {}) {
    super(hostAPI, options);
    // Declare all your persistent state here
    this._state = {
      gain: 1.0,
      mode: "saw",
    };
  }

  // ── UI ────────────────────────────────────────────────────────
  // Build everything inside `el`. Don't touch document.body.
  mount(el) {
    this._el = el;
    el.innerHTML = `
      <div style="padding:20px;font-family:monospace;background:#100c09;color:#f0e8e2">
        <button id="go" style="padding:8px 16px;background:#ff6b35;border:none;
                                border-radius:6px;color:#fff;cursor:pointer">
          ↓ Bounce to track
        </button>
      </div>
    `;
    el.querySelector("#go").addEventListener("click", async () => {
      const buffer = await this._render();
      this.emitBuffer(buffer, "My Plugin Output");  // → new DAW track
      this.notify("Bounced!", "success");
    });
  }

  // ── Cleanup ───────────────────────────────────────────────────
  // Stop audio, cancel timers, disconnect nodes.
  // Always call super.destroy() last.
  destroy() {
    super.destroy();
  }

  // ── State (session save / load) ───────────────────────────────
  getState()  { return { ...this._state }; }
  setState(s) { this._state = { ...this._state, ...s }; }

  // ── Audio ─────────────────────────────────────────────────────
  async _render() {
    const dur = this.b2s(4);   // 4 beats at the current host BPM
    const sr  = this.ctx.sampleRate;
    const off = new OfflineAudioContext(2, Math.ceil(sr * dur), sr);
    // ... build your Web Audio graph here ...
    return off.startRendering();
  }
}
```

---

## The plugin contract

These are the only methods you **must** implement:

| Method | What it does |
|---|---|
| `mount(el)` | Build your UI into `el`. Store it as `this._el`. |
| `destroy()` | Clean up audio nodes and timers. Call `super.destroy()` last. |
| `getState()` | Return a plain JSON-serialisable object of your plugin's state. |
| `setState(s)` | Restore from that object. Called on session load and plugin reopen. |

---

## What the host gives you

These are available the moment your constructor runs:

| Property | Type | Description |
|---|---|---|
| `this.ctx` | `AudioContext` | The DAW's shared audio context. **Do not close it.** |
| `this.bpm` | `number` | Current host BPM. Kept in sync automatically. |
| `this.options` | `object` | Any options passed at registration time. |

---

## Talking back to the DAW

Use these methods inside your plugin. Never call `this.host.*` directly.

```js
// Send rendered audio to a new DAW track
this.emitBuffer(audioBuffer, "Track name");

// Tell the host your state changed (marks session as dirty)
this.emitStateChange();

// Show a toast notification in the DAW
this.notify("Something happened", "success"); // levels: info success warn error

// Time conversion at the current host BPM
this.b2s(beats);    // → seconds
this.s2b(seconds);  // → beats
```

---

## Reacting to the host

Override these methods to respond to DAW events. Always call `super` first:

```js
// BPM changed in the transport
onBpmChange(bpm) {
  super.onBpmChange(bpm);  // keeps this.bpm in sync
  this._updateMyScheduler(bpm);
}

// Transport started playing
onTransportStart(startBeat, audioContextTime) {
  this._mySequencer.start(startBeat);
}

// Transport stopped
onTransportStop() {
  this._mySequencer.stop();
}

// Called every animation frame (~60×/sec) while playing
// Keep this cheap — no allocations, no DOM writes
onPlayheadTick(currentBeat) {
  this._updatePosition(currentBeat);
}
```

---

## Styling your plugin UI

Plugins render inside WAVR PRO's dark Ember theme. Use these CSS variables to stay consistent with the DAW's look:

```css
--wavr-bg:   #100c09;    /* page background          */
--wavr-sf:   #1a1410;    /* surface                  */
--wavr-sf2:  #221c17;    /* raised surface / panels  */
--wavr-sf3:  #2b2219;    /* hover state              */
--wavr-tx:   #f0e8e2;    /* primary text             */
--wavr-mt:   #7a6a60;    /* muted / secondary text   */
--wavr-ac:   #ff6b35;    /* accent — ember orange    */
--wavr-br:   rgba(255,107,53,.1);   /* default border  */
--wavr-br2:  rgba(255,107,53,.22);  /* emphasis border */
```

**One rule:** prefix every CSS class name with your `pluginId` to avoid collisions.

```css
/* Good */
.my-plugin-button { ... }
.my-plugin-grid   { ... }

/* Bad — will clash with other plugins or the DAW */
.button { ... }
.grid   { ... }
```

---

## Checklist before sharing

- [ ] `pluginId` is unique, lowercase, and hyphenated
- [ ] All four required methods are implemented: `mount`, `destroy`, `getState`, `setState`
- [ ] `super.destroy()` is called **last** in your `destroy()`
- [ ] `super.onBpmChange(bpm)` is called if you override `onBpmChange`
- [ ] You use `this.ctx` — you do not create your own `AudioContext`
- [ ] You disconnect all audio nodes in `destroy()`
- [ ] All CSS classes are prefixed with your `pluginId`
- [ ] `getState()` returns only plain JSON (no `AudioBuffer`, no DOM refs)
- [ ] Plugin works standalone: `new MyPlugin(mockHostAPI).mount(el)` doesn't throw

---

## Included example

`examples/ExamplePlugin.js` is a minimal chord pad generator (~120 lines) that demonstrates the full lifecycle. Read it before building your own — it covers every method, the audio rendering pattern, and state persistence in the simplest possible context.

---

## Submitting a plugin

We'd love to feature community plugins in WAVR PRO. To share yours:

1. Make sure it passes the checklist above
2. Test it using `drum-machine-test.html` as a harness (swap in your class)
3. Open a pull request or post in the community forum with:
   - Your plugin file
   - A short description (what it does, what category)
   - A screenshot or screen recording

Plugins that include a test page and a clear description get reviewed faster.

---

## Licence

AGPL 3.0 — you own your plugin code. Build freely, ship commercially, contribute back if you want to.

---

*WAVR Plugin SDK — built with Web Audio API · no dependencies · works in any modern browser*
