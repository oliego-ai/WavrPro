/**
 * DrumMachinePlugin.jsx
 * React wrapper for DrumMachine.js.
 *
 * Props:
 *   audioContext  AudioContext  — pass the DAW's existing context (required)
 *   bpm           number        — synced from host transport
 *   open          bool          — controlled open/close
 *   onClose       fn()          — called when user closes the plugin
 *   onBounce      fn(AudioBuffer, bpm) — called when user clicks Bounce;
 *                                 use this to drop the render into a DAW track
 *   onPatternChange fn(pattern) — called on every step toggle (optional)
 *   initialPattern  object      — restore a saved getPattern() snapshot (optional)
 *   mode          "modal"|"drawer"  — default "modal"
 *
 * Usage inside WavrPro.jsx:
 *
 *   import DrumMachinePlugin from './DrumMachinePlugin';
 *
 *   // In state:
 *   const [dmOpen, setDmOpen] = useState(false);
 *
 *   // In topbar:
 *   <button className="tlbl" onClick={() => setDmOpen(true)}>⬡ Drums</button>
 *
 *   // In JSX (outside daw-body, before closing wavr-root):
 *   <DrumMachinePlugin
 *     audioContext={audioCtxRef.current}
 *     bpm={bpm}
 *     open={dmOpen}
 *     onClose={() => setDmOpen(false)}
 *     onBounce={(buf, bpm) => {
 *       // create a new track + drop the buffer in as a clip at beat 0
 *       const t = addTrack("Drums (DM)");
 *       const dur = s2b(buf.duration, bpm);
 *       setTracks(prev => prev.map(x => x.id !== t.id ? x : {
 *         ...x,
 *         clips: [{ id: uid(), name: "DM Loop", start: 0, duration: dur, buffer: buf }]
 *       }));
 *       snapshot("Bounce drum machine");
 *       setDmOpen(false);
 *     }}
 *   />
 */

import { useEffect, useRef, useState, useCallback } from "react";

// Dynamic import of the pure-JS class so it's code-split and never loaded
// until the plugin is opened for the first time.
let DrumMachineClass = null;
async function loadDrumMachineClass() {
  if (DrumMachineClass) return DrumMachineClass;
  // If bundled together, just require it directly:
  // DrumMachineClass = (await import("./DrumMachine.js")).default || window.DrumMachine;
  // For the standalone / copy-paste scenario:
  if (typeof window !== "undefined" && window.DrumMachine) {
    DrumMachineClass = window.DrumMachine;
  } else {
    // fallback: try dynamic import (works with webpack / vite)
    try {
      const mod = await import("./DrumMachine.js");
      DrumMachineClass = mod.default || mod.DrumMachine || mod;
    } catch {
      console.error("DrumMachine.js not found. Make sure it is in the same directory or on window.DrumMachine.");
    }
  }
  return DrumMachineClass;
}

// ── Styles (scoped to the wrapper only) ──────────────────────
const WRAPPER_STYLES = `
  .dmp-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,.65);
    z-index: 600; display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(3px);
    animation: dmp-fade-in .18s ease;
  }
  .dmp-drawer-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,.45);
    z-index: 600; display: flex; align-items: flex-end; justify-content: center;
    animation: dmp-fade-in .18s ease;
  }
  @keyframes dmp-fade-in { from { opacity:0; } to { opacity:1; } }

  .dmp-modal {
    background: #100c09; border: 1px solid rgba(255,107,53,.3);
    border-radius: 12px; overflow: hidden;
    box-shadow: 0 24px 80px rgba(0,0,0,.7);
    animation: dmp-slide-up .22s cubic-bezier(.4,0,.2,1);
    max-width: 96vw; max-height: 92vh; overflow-y: auto;
  }
  .dmp-drawer {
    background: #100c09; border: 1px solid rgba(255,107,53,.25);
    border-radius: 12px 12px 0 0; overflow: hidden;
    box-shadow: 0 -12px 48px rgba(0,0,0,.6);
    animation: dmp-slide-drawer .22s cubic-bezier(.4,0,.2,1);
    width: 100%; max-width: 100vw; max-height: 80vh; overflow-y: auto;
  }
  @keyframes dmp-slide-up     { from { opacity:0; transform:translateY(18px); } to { opacity:1; transform:translateY(0); } }
  @keyframes dmp-slide-drawer { from { opacity:0; transform:translateY(40px); } to { opacity:1; transform:translateY(0); } }

  .dmp-titlebar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px 0; background: #100c09;
  }
  .dmp-title {
    font-family: 'Syne', 'Segoe UI', sans-serif;
    font-size: 11px; font-weight: 700; letter-spacing: 2px;
    color: rgba(255,107,53,.6);
  }
  .dmp-close {
    width: 26px; height: 26px; border-radius: 50%;
    border: 1px solid rgba(255,107,53,.25); background: transparent;
    color: rgba(255,107,53,.7); cursor: pointer; font-size: 13px;
    display: flex; align-items: center; justify-content: center;
    transition: all .12s; font-family: inherit;
  }
  .dmp-close:hover { background: #e84040; border-color: #e84040; color: #fff; }

  .dmp-mount { padding: 0; }
`;

function injectWrapperStyles() {
  if (document.getElementById("dmp-styles")) return;
  const s = document.createElement("style");
  s.id = "dmp-styles";
  s.textContent = WRAPPER_STYLES;
  document.head.appendChild(s);
}

// ── Component ─────────────────────────────────────────────────
export default function DrumMachinePlugin({
  audioContext,
  bpm          = 120,
  open         = false,
  onClose,
  onBounce,
  onPatternChange,
  initialPattern = null,
  mode         = "modal",
}) {
  const mountRef   = useRef(null);
  const dmRef      = useRef(null);
  const [loaded, setLoaded] = useState(false);

  // Inject wrapper CSS once
  useEffect(() => { injectWrapperStyles(); }, []);

  // Instantiate / destroy the plugin when open changes
  useEffect(() => {
    if (!open) {
      // Destroy existing instance when closed to free audio nodes
      if (dmRef.current) {
        dmRef.current.stop();
        dmRef.current.destroy();
        dmRef.current = null;
      }
      setLoaded(false);
      return;
    }

    // Lazy-load the class then mount
    loadDrumMachineClass().then(DM => {
      if (!DM || !mountRef.current) return;

      const ctx = audioContext || new (window.AudioContext || window.webkitAudioContext)();
      const dm = new DM({ audioContext: ctx, bpm });
      dmRef.current = dm;

      // Wire callbacks
      dm.onRender = (buf, resolvedBpm) => {
        if (typeof onBounce === "function") onBounce(buf, resolvedBpm);
      };
      dm.onPatternChange = (pattern) => {
        if (typeof onPatternChange === "function") onPatternChange(pattern);
      };

      // Restore saved pattern if provided
      if (initialPattern) dm.loadPattern(initialPattern);

      dm.mount(mountRef.current);
      setLoaded(true);
    });

    return () => {
      if (dmRef.current) {
        dmRef.current.stop();
        dmRef.current.destroy();
        dmRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep BPM synced to host transport without remounting
  useEffect(() => {
    if (dmRef.current) dmRef.current.setBpm(bpm);
  }, [bpm]);

  // Expose imperative handle via ref if parent needs it
  useEffect(() => {
    // Parent can read dmRef externally via a forwarded ref if needed
  }, [loaded]);

  // Close on backdrop click
  const handleBackdropClick = useCallback(e => {
    if (e.target === e.currentTarget && typeof onClose === "function") onClose();
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = e => { if (e.key === "Escape" && typeof onClose === "function") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const backdropClass = mode === "drawer" ? "dmp-drawer-backdrop" : "dmp-backdrop";
  const containerClass = mode === "drawer" ? "dmp-drawer" : "dmp-modal";

  return (
    <div className={backdropClass} onMouseDown={handleBackdropClick}>
      <div className={containerClass}>
        <div className="dmp-titlebar">
          <span className="dmp-title">VST · DRUM MACHINE</span>
          <button className="dmp-close" onClick={onClose} title="Close (Esc)">✕</button>
        </div>
        <div className="dmp-mount" ref={mountRef} />
      </div>
    </div>
  );
}

/**
 * useDrumMachine — optional hook for direct imperative access
 *
 * const { dmRef, open, setOpen, pattern, setPattern } = useDrumMachine();
 *
 * <DrumMachinePlugin
 *   {...} open={open} onClose={() => setOpen(false)}
 *   onPatternChange={setPattern} initialPattern={pattern}
 * />
 */
export function useDrumMachine(initialPattern = null) {
  const [open, setOpen]       = useState(false);
  const [pattern, setPattern] = useState(initialPattern);
  return { open, setOpen, pattern, setPattern };
}
