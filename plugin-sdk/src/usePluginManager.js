/**
 * usePluginManager.js
 * React hook for WavrPro.jsx.
 *
 * Manages plugin registration, open/close state, hostAPI construction,
 * transport sync callbacks, and per-plugin state persistence inside sessions.
 *
 * ── Quick setup in WavrPro.jsx ────────────────────────────────
 *
 *   import { usePluginManager } from "./src/usePluginManager";
 *   import PluginShell          from "./src/PluginShell";
 *   import DrumMachine          from "./plugins/DrumMachine/DrumMachine";
 *
 *   // Inside WavrPro component:
 *   const pluginManager = usePluginManager({
 *     audioCtxRef, bpmRef, tracksRef, totalBeatsRef,
 *     playOffsetRef, isPlayingRef,
 *     addTrack, setTracks, snapshot, showToast,
 *     s2b, uid,
 *   });
 *
 *   // Register once on mount:
 *   useEffect(() => {
 *     pluginManager.register(DrumMachine);
 *   }, []);
 *
 *   // Topbar button per plugin:
 *   {pluginManager.plugins.map(p => (
 *     <button key={p.id} className="tlbl" onClick={() => pluginManager.toggle(p.id)}>
 *       ⬡ {p.name}
 *     </button>
 *   ))}
 *
 *   // Render open plugins (before closing </div> of wavr-root):
 *   {pluginManager.plugins.filter(p => p.isOpen).map(p => (
 *     <PluginShell
 *       key={p.id}
 *       pluginClass={p.cls}
 *       hostAPI={pluginManager.getHostAPI(p.id)}
 *       open={p.isOpen}
 *       onClose={() => pluginManager.close(p.id)}
 *       instanceKey={p.id}
 *       initialState={pluginManager.pluginStates[p.id]}
 *     />
 *   ))}
 *
 * ── Session integration ───────────────────────────────────────
 *
 *   // In saveSession():
 *   pluginStates: pluginManager.pluginStates
 *
 *   // In applySession(data):
 *   if (data.pluginStates) pluginManager.restoreAllStates(data.pluginStates);
 *
 * ── Transport sync (optional) ─────────────────────────────────
 *
 *   // In startPlayback():
 *   pluginManager.notifyTransportStart(playOffsetRef.current, ctx.currentTime);
 *
 *   // In stopPlayback():
 *   pluginManager.notifyTransportStop();
 *
 *   // In the rAF animLoop (only call if plugins subscribed):
 *   pluginManager.notifyPlayheadTick(currentBeat());
 */

import { useState, useCallback, useRef } from "react";

export function usePluginManager({
  audioCtxRef,
  bpmRef,
  tracksRef,
  totalBeatsRef,
  playOffsetRef,
  isPlayingRef,
  addTrack,
  setTracks,
  snapshot,
  showToast,
  s2b,
  uid,
}) {
  // Registered plugin descriptors
  // { id, cls, name, color, mode, isOpen }
  const [plugins, setPlugins] = useState([]);

  // Persisted state per plugin id — survives open/close, saved with session
  const [pluginStates, setPluginStates] = useState({});

  // Live plugin instances (not React state — we never want re-renders from this)
  const instancesRef = useRef({});

  // ── Registration ─────────────────────────────────────────────

  /**
   * Register a plugin class.
   * Reads metadata from static fields on the class.
   * Safe to call multiple times — duplicate ids are ignored.
   *
   * @param {typeof WavrPlugin} cls
   * @param {object} [overrides]  Override any static metadata field.
   */
  const register = useCallback((cls, overrides = {}) => {
    const id   = overrides.id    || cls.pluginId    || cls.name;
    const name = overrides.name  || cls.pluginName  || cls.name;
    const color= overrides.color || cls.pluginColor || "#6c5ce7";
    const mode = overrides.mode  || cls.pluginMode  || "modal";

    setPlugins(prev => {
      if (prev.find(p => p.id === id)) return prev;
      return [...prev, { id, cls, name, color, mode, isOpen: false }];
    });
  }, []);

  /**
   * Unregister a plugin by id.
   * Closes it first if currently open.
   */
  const unregister = useCallback((id) => {
    close(id);
    setPlugins(prev => prev.filter(p => p.id !== id));
  }, []);

  // ── Open / close ──────────────────────────────────────────────

  const open   = useCallback(id => setPlugins(p => p.map(x => x.id === id ? { ...x, isOpen: true  } : x)), []);
  const close  = useCallback(id => setPlugins(p => p.map(x => x.id === id ? { ...x, isOpen: false } : x)), []);
  const toggle = useCallback(id => setPlugins(p => p.map(x => x.id === id ? { ...x, isOpen: !x.isOpen } : x)), []);

  // ── HostAPI factory ───────────────────────────────────────────
  // Creates a fresh HostAPI closure for a given plugin id.
  // Each plugin gets its own closure but they all share the same refs.

  const getHostAPI = useCallback((pluginId) => ({
    // ── Live getters ─────────────────────────────────────────
    get audioContext() { return audioCtxRef.current; },
    get bpm()          { return bpmRef.current;      },

    // ── Output: drop a buffer onto a new DAW track ────────────
    onRender(buffer, bpm, label) {
      const b   = bpmRef.current;
      const t   = addTrack(label || "Plugin Output");
      const dur = s2b(buffer.duration, b);
      setTracks(prev => prev.map(x => x.id !== t.id ? x : {
        ...x,
        clips: [{
          id:       uid(),
          name:     label || "Plugin Clip",
          start:    playOffsetRef.current,
          duration: dur,
          buffer,
        }],
      }));
      snapshot("Plugin: " + (label || pluginId));
    },

    // ── Notify host of state change ───────────────────────────
    onStateChange(state) {
      setPluginStates(prev => ({ ...prev, [pluginId]: state }));
    },

    // ── Show a DAW toast ──────────────────────────────────────
    onNotify(msg, level) {
      const isError = level === "error" || level === "warn";
      if (showToast) showToast(msg, isError);
    },

    // ── Create a track ────────────────────────────────────────
    addTrack(name, color) {
      return addTrack(name, color);
    },

    // ── Transport read ────────────────────────────────────────
    getPlayhead() {
      return {
        beat:        playOffsetRef.current,
        isPlaying:   isPlayingRef.current,
        contextTime: audioCtxRef.current?.currentTime ?? 0,
      };
    },

    // ── Tracks read ───────────────────────────────────────────
    getTracks() {
      return (tracksRef.current || []).map(t => ({
        id:        t.id,
        name:      t.name,
        color:     t.color,
        muted:     t.muted,
        solo:      t.solo,
        clipCount: t.clips.length,
      }));
    },
  }), [addTrack, setTracks, snapshot, showToast, s2b, uid]);

  // ── Transport event broadcasting ──────────────────────────────
  // Call these from WavrPro's transport functions to sync plugins.

  const notifyTransportStart = useCallback((startBeat, contextTime) => {
    Object.values(instancesRef.current).forEach(inst => {
      if (inst?.onTransportStart) inst.onTransportStart(startBeat, contextTime);
    });
  }, []);

  const notifyTransportStop = useCallback(() => {
    Object.values(instancesRef.current).forEach(inst => {
      if (inst?.onTransportStop) inst.onTransportStop();
    });
  }, []);

  const notifyPlayheadTick = useCallback((beat) => {
    Object.values(instancesRef.current).forEach(inst => {
      if (inst?.onPlayheadTick) inst.onPlayheadTick(beat);
    });
  }, []);

  const notifyBpmChange = useCallback((bpm) => {
    Object.values(instancesRef.current).forEach(inst => {
      if (inst?.onBpmChange) inst.onBpmChange(bpm);
    });
  }, []);

  // ── Session integration ───────────────────────────────────────

  /**
   * Restore all plugin states from a loaded session.
   * @param {object} states  The pluginStates map from the session file.
   */
  const restoreAllStates = useCallback((states) => {
    if (!states || typeof states !== "object") return;
    setPluginStates(states);
  }, []);

  /**
   * Register a live plugin instance so transport events reach it.
   * Called internally by PluginShell via the instanceKey ref pattern.
   * You can also call this manually if mounting plugins imperatively.
   */
  const registerInstance = useCallback((id, instance) => {
    instancesRef.current[id] = instance;
  }, []);

  const unregisterInstance = useCallback((id) => {
    delete instancesRef.current[id];
  }, []);

  return {
    // State
    plugins,
    pluginStates,

    // Registration
    register,
    unregister,

    // Open/close
    open,
    close,
    toggle,

    // Host API
    getHostAPI,

    // Transport broadcasting
    notifyTransportStart,
    notifyTransportStop,
    notifyPlayheadTick,
    notifyBpmChange,

    // Session
    restoreAllStates,

    // Instance tracking (advanced)
    registerInstance,
    unregisterInstance,
  };
}
