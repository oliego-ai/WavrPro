/**
 * WavrPlugin.js — Base class for all WAVR plugins
 *
 * Extend this class to create a plugin. Implement the required methods
 * (mount, destroy, getState, setState) and use the provided helpers
 * (emitBuffer, emitStateChange, notify) to communicate with the host DAW.
 *
 * The host injects a HostAPI object as the first constructor argument.
 * Use this.host, this.ctx, and this.bpm to access host services.
 *
 * @example
 *   class MyPlugin extends WavrPlugin {
 *     static pluginId    = "my-plugin";
 *     static pluginName  = "My Plugin";
 *     static pluginColor = "#6c5ce7";
 *     static pluginMode  = "modal";  // "modal" | "drawer" | "inline"
 *
 *     constructor(hostAPI, options) {
 *       super(hostAPI, options);
 *       this._state = { gain: 1.0 };
 *     }
 *
 *     mount(el) {
 *       this._el = el;
 *       el.innerHTML = `<button id="go">Bounce</button>`;
 *       el.querySelector("#go").addEventListener("click", async () => {
 *         const buf = await this._renderSomething();
 *         this.emitBuffer(buf);                   // → drops onto a new DAW track
 *         this.notify("Done!", "success");
 *       });
 *     }
 *
 *     destroy() {
 *       // stop timers, disconnect audio nodes
 *       super.destroy();   // always call last — clears el.innerHTML
 *     }
 *
 *     getState() { return { ...this._state }; }
 *     setState(s) { this._state = { ...this._state, ...s }; }
 *   }
 */

class WavrPlugin {
  // ── Static metadata — override in every subclass ─────────────
  /** Unique snake_case identifier.  Used as the registry key. */
  static pluginId    = "wavr-plugin";
  /** Human-readable display name shown in the DAW topbar. */
  static pluginName  = "WAVR Plugin";
  /** Accent colour for the plugin chrome (CSS hex). */
  static pluginColor = "#6c5ce7";
  /** Default UI presentation.  "modal" | "drawer" | "inline" */
  static pluginMode  = "modal";
  /** Categorises the plugin in the browser UI. */
  static pluginCategory = "utility"; // "instrument" | "effect" | "utility" | "generator"
  /** Short description shown in the plugin browser. */
  static pluginDescription = "";
  /** SemVer string. */
  static pluginVersion = "1.0.0";

  /**
   * @param {HostAPI} hostAPI  Injected by WavrPro at instantiation time.
   * @param {object}  options  Plugin-specific config (passed through from the shell).
   */
  constructor(hostAPI, options = {}) {
    if (!hostAPI) throw new Error("WavrPlugin: hostAPI is required");

    // ── Host services ─────────────────────────────────────────
    /** Full HostAPI reference. */
    this.host    = hostAPI;
    /** The shared AudioContext.  Do NOT close it — it belongs to the host. */
    this.ctx     = hostAPI.audioContext;
    /** BPM snapshot at mount time.  Updated by onBpmChange(). */
    this.bpm     = hostAPI.bpm;
    /** Options passed by the consuming application. */
    this.options = options;

    // ── Internal ──────────────────────────────────────────────
    /** The DOM element this plugin is mounted into. Set by mount(). */
    this._el        = null;
    /** Serialisable plugin state.  Persist everything here. */
    this._state     = {};
    this._destroyed = false;
  }

  // ── Required — every plugin MUST implement these ─────────────

  /**
   * Build and inject the plugin UI into `el`.
   * Called once after construction.  Always set this._el = el.
   * @param {HTMLElement} el
   */
  mount(el) {
    throw new Error(`${this.constructor.name}: mount(el) is not implemented`);
  }

  /**
   * Tear down the plugin.
   * Stop all audio, remove event listeners, cancel timers.
   * Always call super.destroy() at the END of your override — it clears the DOM.
   */
  destroy() {
    this._destroyed = true;
    if (this._el) this._el.innerHTML = "";
  }

  /**
   * Return a plain JSON-serialisable snapshot of plugin state.
   * Called by the host when saving a session.
   * @returns {object}
   */
  getState() {
    return { ...this._state };
  }

  /**
   * Restore state from a previously returned getState() object.
   * Called by the host when loading a session or re-opening the plugin.
   * @param {object} state
   */
  setState(state) {
    this._state = { ...this._state, ...state };
  }

  // ── Transport hooks — override as needed ──────────────────────

  /**
   * Host calls this whenever the transport BPM changes.
   * Call super.onBpmChange(bpm) to keep this.bpm in sync.
   * @param {number} bpm
   */
  onBpmChange(bpm) {
    this.bpm = bpm;
  }

  /**
   * Host calls this when transport starts playing.
   * @param {number} startBeat      Beat position playback starts at.
   * @param {number} contextTime    audioContext.currentTime at play start.
   */
  onTransportStart(startBeat, contextTime) {}

  /** Host calls this when transport stops. */
  onTransportStop() {}

  /**
   * Host calls this on every rAF frame while playing.
   * Keep implementation cheap — it runs 60×/sec.
   * @param {number} currentBeat
   */
  onPlayheadTick(currentBeat) {}

  // ── Helpers — use these to talk back to the host ──────────────

  /**
   * Send an AudioBuffer to the host to be placed on a new track.
   * Equivalent to a plugin "bouncing" its output into the DAW timeline.
   *
   * @param {AudioBuffer} buffer    The rendered audio.
   * @param {string}      [label]   Optional track / clip name.
   * @throws {TypeError}  If buffer is not a valid AudioBuffer.
   */
  emitBuffer(buffer, label) {
    if (!(buffer instanceof AudioBuffer))
      throw new TypeError("emitBuffer: argument must be an AudioBuffer");
    if (this._destroyed) return;
    this.host.onRender(buffer, this.bpm, label || this.constructor.pluginName);
  }

  /**
   * Tell the host that internal state has changed.
   * Triggers a session "dirty" flag so the user is prompted to save.
   */
  emitStateChange() {
    if (this._destroyed) return;
    this.host.onStateChange(this.getState());
  }

  /**
   * Display a toast notification in the host DAW.
   * @param {string}  message
   * @param {"info"|"success"|"warn"|"error"} [level="info"]
   */
  notify(message, level = "info") {
    if (this._destroyed) return;
    this.host.onNotify(message, level);
  }

  // ── Utility ───────────────────────────────────────────────────

  /**
   * Convenience: beats → seconds at current BPM.
   * @param {number} beats
   * @returns {number} seconds
   */
  b2s(beats) { return (beats / this.bpm) * 60; }

  /**
   * Convenience: seconds → beats at current BPM.
   * @param {number} seconds
   * @returns {number} beats
   */
  s2b(seconds) { return (seconds / 60) * this.bpm; }
}

// ── HostAPI shape (informational — not enforced at runtime) ──────
//
// The object WavrPro constructs and passes to each plugin:
//
// interface HostAPI {
//   readonly audioContext : AudioContext
//   readonly bpm          : number
//
//   onRender(buffer: AudioBuffer, bpm: number, label?: string): void
//     Drop a rendered AudioBuffer onto a new DAW track.
//
//   onStateChange(state: object): void
//     Notify the host that plugin state changed.
//
//   onNotify(message: string, level: "info"|"success"|"warn"|"error"): void
//     Show a toast in the DAW UI.
//
//   addTrack(name: string, color?: string): Track
//     Create an empty track and return it.
//
//   getPlayhead(): { beat: number, isPlaying: boolean, contextTime: number }
//     Read the current transport position.
//
//   getTracks(): TrackSummary[]
//     Read-only snapshot of all current tracks.
// }

if (typeof module !== "undefined" && module.exports) {
  module.exports = WavrPlugin;
} else if (typeof window !== "undefined") {
  window.WavrPlugin = WavrPlugin;
}
