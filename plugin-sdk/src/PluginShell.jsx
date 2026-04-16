/**
 * PluginShell.jsx
 * Generic React wrapper for any WavrPlugin subclass.
 * Handles mounting, lifecycle, modal/drawer chrome, BPM sync, and state persistence.
 *
 * Works with every plugin that extends WavrPlugin — no per-plugin wiring needed.
 *
 * Props:
 *   pluginClass     Class           WavrPlugin subclass constructor (required)
 *   hostAPI         HostAPI         The object from usePluginManager (required)
 *   open            boolean         Controlled open/close
 *   onClose         () => void      Called when user closes
 *   mode            string          "modal" | "drawer" | "inline"  (default: from static or "modal")
 *   options         object          Passed to the plugin constructor as second arg
 *   initialState    object          Passed to plugin.setState() after first mount
 *   instanceKey     string          When set, state persists across open/close cycles
 */

import { useEffect, useRef } from "react";

// ── Shell CSS injected once into <head> ───────────────────────
const SHELL_CSS = `
  .wvr-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,.68);
    z-index: 600; display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(4px);
    animation: wvr-fade-in .18s ease;
  }
  .wvr-drawer-bg {
    position: fixed; inset: 0; background: rgba(0,0,0,.5);
    z-index: 600; display: flex; align-items: flex-end; justify-content: center;
    animation: wvr-fade-in .18s ease;
  }
  @keyframes wvr-fade-in { from { opacity: 0 } to { opacity: 1 } }

  .wvr-modal-box {
    background: #100c09;
    border: 1px solid rgba(255,107,53,.28);
    border-radius: 12px;
    overflow: hidden;
    max-width: 96vw; max-height: 92vh; overflow-y: auto;
    box-shadow: 0 24px 80px rgba(0,0,0,.7);
    animation: wvr-slide-up .2s cubic-bezier(.4,0,.2,1);
  }
  .wvr-drawer-box {
    background: #100c09;
    border: 1px solid rgba(255,107,53,.22);
    border-radius: 12px 12px 0 0;
    width: 100%; max-height: 82vh; overflow-y: auto;
    animation: wvr-slide-drawer .2s cubic-bezier(.4,0,.2,1);
  }
  @keyframes wvr-slide-up {
    from { opacity: 0; transform: translateY(16px) }
    to   { opacity: 1; transform: none }
  }
  @keyframes wvr-slide-drawer {
    from { opacity: 0; transform: translateY(32px) }
    to   { opacity: 1; transform: none }
  }

  .wvr-titlebar {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px 0; flex-shrink: 0;
  }
  .wvr-plugin-dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  }
  .wvr-plugin-label {
    font-family: 'Syne', 'Segoe UI', sans-serif;
    font-size: 11px; font-weight: 700; letter-spacing: 2px;
    color: rgba(255,107,53,.55); flex: 1;
  }
  .wvr-close-btn {
    width: 24px; height: 24px; border-radius: 50%;
    border: 1px solid rgba(255,107,53,.22); background: transparent;
    color: rgba(255,107,53,.65); cursor: pointer; font-size: 12px;
    display: flex; align-items: center; justify-content: center;
    transition: all .12s; font-family: inherit; padding: 0;
  }
  .wvr-close-btn:hover { background: #e84040; border-color: #e84040; color: #fff; }
  .wvr-plugin-mount { min-height: 40px; }
`;

let shellStylesInjected = false;
function injectShellStyles() {
  if (shellStylesInjected || document.getElementById("wvr-shell-css")) return;
  const s = document.createElement("style");
  s.id = "wvr-shell-css";
  s.textContent = SHELL_CSS;
  document.head.appendChild(s);
  shellStylesInjected = true;
}

// ── Component ─────────────────────────────────────────────────
export default function PluginShell({
  pluginClass,
  hostAPI,
  open         = false,
  onClose,
  mode,           // falls back to pluginClass.pluginMode, then "modal"
  options      = {},
  initialState = null,
  instanceKey  = null,
}) {
  const mountRef   = useRef(null);
  const pluginRef  = useRef(null);
  const stateCache = useRef(initialState);

  const resolvedMode = mode || pluginClass?.pluginMode || "modal";

  useEffect(() => { injectShellStyles(); }, []);

  // Mount / destroy on open toggle
  useEffect(() => {
    if (!open) {
      if (pluginRef.current) {
        if (instanceKey) stateCache.current = pluginRef.current.getState();
        pluginRef.current.destroy();
        pluginRef.current = null;
      }
      return;
    }
    if (!pluginClass || !mountRef.current) return;

    const plugin = new pluginClass(hostAPI, options);
    pluginRef.current = plugin;

    const restoreState = stateCache.current || initialState;
    if (restoreState) {
      try { plugin.setState(restoreState); } catch (e) { /* ignore */ }
    }

    plugin.mount(mountRef.current);

    return () => {
      if (pluginRef.current) {
        if (instanceKey) stateCache.current = pluginRef.current.getState();
        pluginRef.current.destroy();
        pluginRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pluginClass]);

  // Keep BPM synced without remounting
  useEffect(() => {
    if (pluginRef.current && typeof pluginRef.current.onBpmChange === "function") {
      pluginRef.current.onBpmChange(hostAPI.bpm);
    }
  }, [hostAPI?.bpm]);

  // Escape key to close
  useEffect(() => {
    if (!open) return;
    const handler = e => { if (e.key === "Escape" && onClose) onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open && resolvedMode !== "inline") return null;

  const name  = pluginClass?.pluginName  || "Plugin";
  const color = pluginClass?.pluginColor || "#6c5ce7";

  const handleBackdrop = e => {
    if (e.target === e.currentTarget && onClose) onClose();
  };

  const titlebar = (
    <div className="wvr-titlebar">
      <div className="wvr-plugin-dot" style={{ background: color }} />
      <span className="wvr-plugin-label">{name.toUpperCase()}</span>
      {onClose && (
        <button className="wvr-close-btn" onClick={onClose} title="Close (Esc)">✕</button>
      )}
    </div>
  );

  const mountEl = <div className="wvr-plugin-mount" ref={mountRef} />;

  if (resolvedMode === "inline") {
    return <div ref={mountRef} />;
  }

  if (resolvedMode === "drawer") {
    return (
      <div className="wvr-drawer-bg" onMouseDown={handleBackdrop}>
        <div className="wvr-drawer-box">
          {titlebar}
          {mountEl}
        </div>
      </div>
    );
  }

  // default: modal
  return (
    <div className="wvr-backdrop" onMouseDown={handleBackdrop}>
      <div className="wvr-modal-box">
        {titlebar}
        {mountEl}
      </div>
    </div>
  );
}
