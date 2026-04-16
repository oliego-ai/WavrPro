/**
 * ExamplePlugin.js
 * Minimal reference implementation of WavrPlugin.
 *
 * A simple 4-oscillator chord pad generator that:
 *   - Renders a chord progression to an AudioBuffer on demand
 *   - Persists chord selection and BPM across sessions
 *   - Demonstrates every WavrPlugin lifecycle method
 *
 * Copy this file and rename everything to create your own plugin.
 */

class ExamplePlugin extends WavrPlugin {
  // ── Static metadata ────────────────────────────────────────
  static pluginId          = "example-chord-pad";
  static pluginName        = "Chord Pad";
  static pluginColor       = "#00cec9";
  static pluginMode        = "modal";
  static pluginCategory    = "instrument";
  static pluginDescription = "4-bar chord pad generator. Choose a key, click Bounce.";
  static pluginVersion     = "1.0.0";

  constructor(hostAPI, options = {}) {
    super(hostAPI, options);

    // ── Declare your default state ────────────────────────────
    this._state = {
      key:        "C",
      progression: [0, 5, 7, 9],  // semitone offsets from root
      bars:       4,
      octave:     4,
    };
  }

  // ── mount(el) ─────────────────────────────────────────────
  // Build your UI here. Keep it inside el — don't touch the document body.
  mount(el) {
    this._el = el;
    this._render();
  }

  _render() {
    if (!this._el) return;
    const { key, bars } = this._state;
    const KEYS = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

    this._el.innerHTML = `
      <div style="
        padding: 20px; font-family: 'JetBrains Mono', monospace;
        background: #100c09; color: #f0e8e2; min-width: 320px;
      ">
        <div style="margin-bottom:16px">
          <label style="font-size:9px;color:#7a6a60;letter-spacing:1px;display:block;margin-bottom:6px">KEY</label>
          <div style="display:flex;gap:4px;flex-wrap:wrap" id="key-btns">
            ${KEYS.map(k => `
              <button data-key="${k}" style="
                padding:4px 8px;border-radius:4px;border:1px solid ${k===key?"#00cec9":"rgba(0,206,201,.2)"};
                background:${k===key?"#00cec9":"transparent"};
                color:${k===key?"#0a2c2c":"#00cec9"};
                font-family:inherit;font-size:10px;cursor:pointer;transition:all .1s;
              ">${k}</button>
            `).join("")}
          </div>
        </div>

        <div style="margin-bottom:16px">
          <label style="font-size:9px;color:#7a6a60;letter-spacing:1px;display:block;margin-bottom:6px">BARS</label>
          <div style="display:flex;gap:4px">
            ${[1,2,4,8].map(b => `
              <button data-bars="${b}" style="
                padding:4px 10px;border-radius:4px;
                border:1px solid ${b===bars?"#00cec9":"rgba(0,206,201,.2)"};
                background:${b===bars?"#00cec9":"transparent"};
                color:${b===bars?"#0a2c2c":"#00cec9"};
                font-family:inherit;font-size:10px;cursor:pointer;
              ">${b}</button>
            `).join("")}
          </div>
        </div>

        <div style="display:flex;gap:8px;align-items:center">
          <button id="bounce-btn" style="
            padding:8px 20px;background:#00cec9;color:#0a2c2c;
            border:none;border-radius:6px;cursor:pointer;
            font-family:inherit;font-size:11px;font-weight:700;flex:1;
            transition:opacity .12s;
          ">↓ Bounce to Track</button>
          <div id="status" style="font-size:9px;color:#7a6a60"></div>
        </div>
      </div>
    `;

    // Wire key buttons
    this._el.querySelectorAll("[data-key]").forEach(btn => {
      btn.addEventListener("click", () => {
        this._state.key = btn.dataset.key;
        this.emitStateChange();  // mark session dirty
        this._render();          // re-render with new selection
      });
    });

    // Wire bars buttons
    this._el.querySelectorAll("[data-bars]").forEach(btn => {
      btn.addEventListener("click", () => {
        this._state.bars = parseInt(btn.dataset.bars);
        this.emitStateChange();
        this._render();
      });
    });

    // Wire bounce
    this._el.querySelector("#bounce-btn").addEventListener("click", async () => {
      const btn = this._el.querySelector("#bounce-btn");
      const status = this._el.querySelector("#status");
      btn.textContent = "…"; btn.disabled = true;
      status.textContent = "Rendering…";
      try {
        const buf = await this._render_audio();
        this.emitBuffer(buf, `${this._state.key} Pad`);  // → new DAW track
        this.notify("Pad bounced to track!", "success");
        status.textContent = "Done!";
        setTimeout(() => { if (status) status.textContent = ""; }, 2000);
      } catch (e) {
        this.notify("Render failed: " + e.message, "error");
        status.textContent = "Error";
      }
      btn.textContent = "↓ Bounce to Track"; btn.disabled = false;
    });
  }

  // ── Audio synthesis ────────────────────────────────────────
  async _render_audio() {
    const { key, progression, bars, octave } = this._state;
    const KEYS = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    const rootMidi = 60 + KEYS.indexOf(key) + (octave - 4) * 12;
    const barSec   = this.b2s(4);                // 1 bar = 4 beats
    const totalSec = barSec * bars;
    const sr       = this.ctx.sampleRate;
    const off      = new OfflineAudioContext(2, Math.ceil(sr * totalSec), sr);

    const chordFreqs = progression.map(interval =>
      440 * Math.pow(2, (rootMidi + interval - 69) / 12)
    );

    // Play chord once, let it ring for all bars
    chordFreqs.forEach(freq => {
      // Two slightly detuned sines per voice for width
      [-4, 4].forEach(cents => {
        const o = off.createOscillator();
        const g = off.createGain();
        o.type = "triangle";
        o.frequency.value = freq * Math.pow(2, cents / 1200);
        g.gain.setValueAtTime(0, 0);
        g.gain.linearRampToValueAtTime(0.1, 0.03);
        g.gain.setValueAtTime(0.1, totalSec - 0.5);
        g.gain.linearRampToValueAtTime(0, totalSec);
        o.connect(g); g.connect(off.destination);
        o.start(0); o.stop(totalSec + 0.05);
      });
    });

    return off.startRendering();
  }

  // ── Lifecycle ──────────────────────────────────────────────

  destroy() {
    // No audio nodes to disconnect (OfflineAudioContext auto-closes)
    super.destroy();
  }

  getState()    { return { ...this._state }; }
  setState(s)   { this._state = { ...this._state, ...s }; if (this._el) this._render(); }

  onBpmChange(bpm) {
    super.onBpmChange(bpm);
    // Plugin responds to host BPM changes — nothing to do for this simple case
  }
}

// ── Export ────────────────────────────────────────────────────
if (typeof module !== "undefined" && module.exports) {
  module.exports = ExamplePlugin;
} else if (typeof window !== "undefined") {
  window.ExamplePlugin = ExamplePlugin;
}
