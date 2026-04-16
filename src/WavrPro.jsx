import { useState, useEffect, useRef, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────
const PPB = 44;
const COLORS = ["#6c5ce7","#00cec9","#fdcb6e","#e17055","#74b9ff","#a29bfe","#55efc4","#fd79a8","#ffeaa7","#b2bec3"];
const OSC_TYPES = ["sawtooth","triangle","square","sine"];
const BASE_FREQS = [82,110,165,220,330,440,523,659,784,880];
const IDB_NAME = "wavr-pro", IDB_STORE = "sessions";
const MAX_HISTORY = 40;
const EQ_BAND_DEFS = [
  { label:"SUB",  freq:60,    type:"lowshelf"  },
  { label:"BASS", freq:200,   type:"peaking"   },
  { label:"LO-M", freq:600,   type:"peaking"   },
  { label:"MID",  freq:1800,  type:"peaking"   },
  { label:"HI-M", freq:5000,  type:"peaking"   },
  { label:"AIR",  freq:12000, type:"highshelf" },
];

// ─── Pure helpers ────────────────────────────────────────────
const uid  = () => performance.now().toString(36) + Math.random().toString(36).slice(2);
const esc  = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const clamp= (v,a,b) => Math.min(b, Math.max(a, v));
const defaultEQ = () => EQ_BAND_DEFS.map(b => ({ ...b, gain:0, enabled:true }));

// Audio math (bpm captured at call-site)
const b2s  = (b, bpm) => (b / bpm) * 60;
const s2b  = (s, bpm) => (s / 60) * bpm;
const b2x  = b => b * PPB;
const x2b  = x => x / PPB;
const totalW = beats => b2x(beats) + 140;

// IDB helpers
function openIDB() {
  return new Promise((res,rej) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE, { keyPath:"id" });
    req.onsuccess = e => res(e.target.result);
    req.onerror   = () => rej(req.error);
  });
}
async function idbPut(data) {
  const db = await openIDB();
  return new Promise((res,rej) => {
    const tx = db.transaction(IDB_STORE,"readwrite");
    tx.objectStore(IDB_STORE).put(data);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(id) {
  const db = await openIDB();
  return new Promise((res,rej) => {
    const tx  = db.transaction(IDB_STORE,"readonly");
    const req = tx.objectStore(IDB_STORE).get(id);
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
  });
}
async function idbDel(id) {
  const db = await openIDB();
  return new Promise(res => {
    const tx = db.transaction(IDB_STORE,"readwrite");
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = res;
  });
}

function bufferToRaw(buf) {
  const channels = [];
  for (let c = 0; c < buf.numberOfChannels; c++)
    channels.push(Array.from(buf.getChannelData(c)));
  return { channels, sampleRate: buf.sampleRate, length: buf.length };
}
function rawToBuffer(raw, ctx) {
  const ab = ctx.createBuffer(raw.channels.length, raw.length, raw.sampleRate);
  raw.channels.forEach((ch,i) => ab.getChannelData(i).set(ch));
  return ab;
}

function buildEQChain(ctx, dest, eqBands) {
  const nodes = eqBands.map(b => {
    const f = ctx.createBiquadFilter();
    f.type = b.type; f.frequency.value = b.freq;
    f.gain.value = b.enabled ? b.gain : 0; f.Q.value = 1;
    return f;
  });
  nodes.forEach((n,i) => { if (i < nodes.length-1) n.connect(nodes[i+1]); });
  nodes[nodes.length-1].connect(dest);
  return nodes;
}

function approxBiquad(band, freq) {
  if (band.type === "peaking") {
    const w0 = 2*Math.PI*band.freq/44100;
    const wr = 2*Math.PI*freq/44100;
    const bw = w0; const dw = wr - w0;
    return band.gain * Math.exp(-(dw*dw)/(2*bw*bw*0.5));
  } else if (band.type === "lowshelf")  return band.gain * (1 - Math.min(1, freq/band.freq));
  else if (band.type === "highshelf") return band.gain * (1 - Math.min(1, band.freq/freq));
  return 0;
}

function encodeWAV(ab) {
  const nc=ab.numberOfChannels, SR=ab.sampleRate, nf=ab.length;
  const ba=nc*2, br=SR*ba, ds=nf*ba;
  const buf=new ArrayBuffer(44+ds); const v=new DataView(buf);
  const ws=(o,s)=>{ for(let i=0;i<s.length;i++) v.setUint8(o+i,s.charCodeAt(i)); };
  ws(0,"RIFF"); v.setUint32(4,36+ds,true); ws(8,"WAVE"); ws(12,"fmt ");
  v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,nc,true);
  v.setUint32(24,SR,true); v.setUint32(28,br,true); v.setUint16(32,ba,true);
  v.setUint16(34,16,true); ws(36,"data"); v.setUint32(40,ds,true);
  let off=44; const ch=[]; for(let c=0;c<nc;c++) ch.push(ab.getChannelData(c));
  for(let i=0;i<nf;i++) for(let c=0;c<nc;c++){
    const s=clamp(ch[c][i],-1,1);
    v.setInt16(off, s<0?s*0x8000:s*0x7fff, true); off+=2;
  }
  return buf;
}

// ─── Inline CSS string ───────────────────────────────────────
const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Syne:wght@700;800&display=swap');
.wavr-root *{box-sizing:border-box;margin:0;padding:0}
.wavr-root{
  --bg:#080810;--sf:#0f0f1a;--sf2:#161624;--sf3:#1e1e30;--sf4:#252538;
  --br:rgba(255,255,255,.06);--br2:rgba(255,255,255,.12);--br3:rgba(255,255,255,.22);
  --tx:#ddddf0;--mt:#666688;--dm:#44445a;
  --ac:#6c5ce7;--acg:rgba(108,92,231,.3);
  --tl:#00cec9;--tlg:rgba(0,206,201,.25);
  --am:#fdcb6e;--amg:rgba(253,203,110,.25);
  --rd:#e17055;--rdg:rgba(225,112,85,.25);
  --gn:#55efc4;
  --th:72px; --hw:148px;
  display:flex;flex-direction:column;height:100vh;
  background:var(--bg);color:var(--tx);
  font-family:'JetBrains Mono',monospace;font-size:11px;
  -webkit-font-smoothing:antialiased;overflow:hidden;
}
/* TOPBAR */
.wavr-root .topbar{display:flex;align-items:center;gap:5px;padding:6px 10px;background:var(--sf);border-bottom:1px solid var(--br2);flex-shrink:0;flex-wrap:wrap;z-index:50}
.wavr-root .logo{font-family:'Syne',sans-serif;font-size:16px;font-weight:800;letter-spacing:3px;background:linear-gradient(135deg,var(--ac),var(--tl));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-right:4px;white-space:nowrap}
.wavr-root .logo sup{font-size:8px;font-weight:600;-webkit-text-fill-color:var(--mt);font-family:'JetBrains Mono',monospace;letter-spacing:1px}
.wavr-root .tbtn{width:28px;height:28px;border:1px solid var(--br2);background:var(--sf2);color:var(--tx);border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:12px;transition:all .12s;flex-shrink:0;font-family:inherit}
.wavr-root .tbtn:hover{background:var(--sf3);border-color:var(--ac);color:var(--ac)}
.wavr-root .tbtn.active{background:var(--ac);border-color:var(--ac);color:#fff;box-shadow:0 0 10px var(--acg)}
.wavr-root .tbtn.rec-active{background:var(--rd);border-color:var(--rd);color:#fff;animation:wavr-recpulse 1s ease-in-out infinite}
@keyframes wavr-recpulse{0%,100%{box-shadow:0 0 6px var(--rdg)}50%{box-shadow:0 0 16px var(--rdg)}}
.wavr-root .bpm-wrap{display:flex;align-items:center;gap:4px;background:var(--sf2);border:1px solid var(--br2);border-radius:5px;padding:3px 7px}
.wavr-root .bpm-wrap label{color:var(--mt);font-size:9px;letter-spacing:1px}
.wavr-root .bpm-input{background:transparent;border:none;color:var(--am);font-family:inherit;font-size:13px;font-weight:700;width:34px;outline:none;text-align:center}
.wavr-root .timecode{font-size:14px;font-weight:700;letter-spacing:2px;color:var(--tl);background:var(--sf2);border:1px solid var(--br2);border-radius:5px;padding:3px 8px;font-variant-numeric:tabular-nums;white-space:nowrap;min-width:90px;text-align:center}
.wavr-root .sep{width:1px;height:18px;background:var(--br2);flex-shrink:0;margin:0 2px}
.wavr-root .tlbl{height:28px;padding:0 9px;border:1px solid var(--br2);background:var(--sf2);color:var(--tx);border-radius:5px;cursor:pointer;display:flex;align-items:center;gap:5px;font-family:inherit;font-size:10px;letter-spacing:.5px;white-space:nowrap;flex-shrink:0;transition:all .12s}
.wavr-root .tlbl:hover{background:var(--sf3);border-color:var(--ac);color:var(--ac)}
.wavr-root .tlbl.tl{color:var(--tl);border-color:rgba(0,206,201,.3)}
.wavr-root .tlbl.tl:hover{background:rgba(0,206,201,.07);border-color:var(--tl)}
.wavr-root .tlbl.am{color:var(--am);border-color:rgba(253,203,110,.3)}
.wavr-root .tlbl.am:hover{background:rgba(253,203,110,.07);border-color:var(--am)}
.wavr-root .add-track-btn{height:28px;padding:0 10px;background:var(--ac);color:#fff;border:none;border-radius:5px;cursor:pointer;font-family:inherit;font-size:10px;font-weight:700;letter-spacing:1px;white-space:nowrap;flex-shrink:0;margin-left:auto;transition:opacity .12s}
.wavr-root .add-track-btn:hover{opacity:.82}
/* NOTICES */
.wavr-root .notice{padding:4px 10px;font-size:10px;display:flex;align-items:center;gap:7px;border-bottom:1px solid transparent}
.wavr-root .limit-bar{background:#12100a;border-color:rgba(253,203,110,.2)}
.wavr-root .limit-bar .ni{color:var(--am)}
.wavr-root .limit-bar .nt{color:#9a8050}
.wavr-root .limit-bar .nt strong{color:var(--am)}
.wavr-root .ctx-notice{background:rgba(0,206,201,.06);border-color:rgba(0,206,201,.15)}
.wavr-root .ctx-notice .ni,.wavr-root .ctx-notice .nt{color:var(--tl)}
.wavr-root .export-bar{background:rgba(108,92,231,.08);border-color:rgba(108,92,231,.2)}
.wavr-root .export-bar .nt{color:#a89ff7;flex:1}
.wavr-root .export-bar progress{width:120px;height:5px;border-radius:3px;accent-color:var(--ac)}
.wavr-root .export-bar .ep{color:var(--ac);font-size:10px;min-width:32px}
/* BODY */
.wavr-root .daw-body{display:flex;flex:1;overflow:hidden;min-height:0}
/* HEADERS */
.wavr-root .track-headers{width:var(--hw);flex-shrink:0;background:var(--sf);border-right:1px solid var(--br2);overflow:hidden;position:relative;display:flex;flex-direction:column}
.wavr-root .th-scroll{flex:1;overflow:hidden}
/* TIMELINE */
.wavr-root .timeline-wrap{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.wavr-root .ruler-wrap{flex-shrink:0;background:var(--sf);border-bottom:1px solid var(--br2);position:relative;overflow:hidden;height:26px}
.wavr-root .ruler-canvas{position:absolute;top:0;left:0;height:26px;will-change:transform}
.wavr-root .tracks-scroll{flex:1;overflow:scroll;position:relative;-webkit-overflow-scrolling:touch}
.wavr-root .tracks-scroll::-webkit-scrollbar{width:5px;height:5px}
.wavr-root .tracks-scroll::-webkit-scrollbar-thumb{background:var(--sf4);border-radius:3px}
.wavr-root .tracks-container{position:relative}
/* PLAYHEAD */
.wavr-root .playhead{position:absolute;top:0;width:1px;background:var(--ac);z-index:10;pointer-events:none;will-change:transform;box-shadow:0 0 6px var(--acg)}
.wavr-root .playhead::before{content:'';position:absolute;top:0;left:-5px;border:6px solid transparent;border-top:8px solid var(--ac)}
/* TRACK HEADERS */
.wavr-root .track-header{height:var(--th);border-bottom:1px solid var(--br);display:flex;flex-direction:column;justify-content:center;padding:5px 7px;gap:5px;transition:background .12s;cursor:pointer}
.wavr-root .track-header:hover{background:rgba(255,255,255,.02)}
.wavr-root .track-header.selected{background:rgba(108,92,231,.07);border-right:2px solid var(--ac)}
.wavr-root .th-top{display:flex;align-items:center;gap:4px}
.wavr-root .track-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.wavr-root .track-name-input{font-size:10px;font-weight:600;color:var(--tx);background:transparent;border:none;outline:none;font-family:inherit;width:0;flex:1;min-width:0;cursor:text}
.wavr-root .track-name-input:focus{background:var(--sf3);outline:1px solid var(--ac);border-radius:2px;padding:1px 3px}
.wavr-root .th-btns{display:flex;align-items:center;gap:3px}
.wavr-root .ic-btn{width:17px;height:17px;border:1px solid var(--br2);background:var(--sf3);border-radius:3px;cursor:pointer;font-size:8px;display:flex;align-items:center;justify-content:center;color:var(--mt);transition:all .1s;font-family:inherit;flex-shrink:0}
.wavr-root .ic-btn:hover{background:var(--sf4);color:var(--tx)}
.wavr-root .ic-btn.on-r{background:var(--rd);border-color:var(--rd);color:#fff}
.wavr-root .ic-btn.on-m{background:var(--am);border-color:var(--am);color:#111}
.wavr-root .ic-btn.on-s{background:var(--tl);border-color:var(--tl);color:#111}
.wavr-root .ic-btn.on-e{background:var(--ac);border-color:var(--ac);color:#fff}
.wavr-root .del-ic{background:transparent;border-color:transparent;color:var(--dm)}
.wavr-root .del-ic:hover{background:var(--rd);border-color:var(--rd);color:#fff}
.wavr-root .vol-row{display:flex;align-items:center;gap:5px}
.wavr-root .vol-label{color:var(--mt);font-size:8px;min-width:14px;text-align:right}
.wavr-root .vol-slider{flex:1;-webkit-appearance:none;height:2px;background:var(--sf4);border-radius:2px;outline:none;cursor:pointer;min-width:0}
.wavr-root .vol-slider::-webkit-slider-thumb{-webkit-appearance:none;width:9px;height:9px;background:var(--ac);border-radius:50%;cursor:pointer}
/* LANE */
.wavr-root .track-lane{height:var(--th);border-bottom:1px solid var(--br);position:relative;cursor:crosshair;transition:background .1s}
.wavr-root .track-lane:hover{background:rgba(108,92,231,.025)}
.wavr-root .track-lane.dimmed{opacity:.3}
.wavr-root .track-lane.drag-over{background:rgba(108,92,231,.1);outline:1px dashed var(--ac)}
/* CLIP */
.wavr-root .clip{position:absolute;top:5px;bottom:5px;border-radius:5px;overflow:hidden;cursor:grab;user-select:none;display:flex;align-items:center;padding:0 6px;min-width:14px;will-change:transform}
.wavr-root .clip:active{cursor:grabbing}
.wavr-root .clip.selected{box-shadow:0 0 0 2px #fff,0 0 12px rgba(255,255,255,.2)}
.wavr-root .clip-label{font-size:9px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff;pointer-events:none;position:relative;z-index:1;text-shadow:0 1px 4px rgba(0,0,0,.7)}
.wavr-root .wf-canvas{position:absolute;inset:0;width:100%;height:100%;opacity:.28;pointer-events:none}
.wavr-root .clip-resize{position:absolute;right:0;top:0;bottom:0;width:6px;cursor:ew-resize;z-index:2;background:rgba(255,255,255,.12);opacity:0;transition:opacity .1s}
.wavr-root .clip:hover .clip-resize{opacity:1}
/* CONTEXT MENU */
.wavr-root .ctx-menu{position:fixed;background:var(--sf2);border:1px solid var(--br3);border-radius:7px;padding:4px;z-index:1000;min-width:152px;box-shadow:0 8px 32px rgba(0,0,0,.5)}
.wavr-root .cm-item{padding:6px 10px;border-radius:4px;cursor:pointer;font-size:10px;color:var(--tx);display:flex;align-items:center;gap:7px;transition:background .1s}
.wavr-root .cm-item:hover{background:var(--sf3)}
.wavr-root .cm-item.danger{color:var(--rd)}
.wavr-root .cm-item.danger:hover{background:rgba(225,112,85,.12)}
.wavr-root .cm-sep{height:1px;background:var(--br);margin:3px 0}
/* BOTTOM */
.wavr-root .bottom-panel{flex-shrink:0;background:var(--sf);border-top:1px solid var(--br2);display:flex;height:160px}
.wavr-root .mixer-section{display:flex;align-items:flex-end;padding:8px 10px;gap:6px;overflow-x:auto;flex-shrink:0;border-right:1px solid var(--br2)}
.wavr-root .mixer-section::-webkit-scrollbar{height:3px}
.wavr-root .mixer-section::-webkit-scrollbar-thumb{background:var(--sf4)}
.wavr-root .mixer-strip{display:flex;flex-direction:column;align-items:center;gap:3px;padding:4px 7px;border:1px solid var(--br);border-radius:6px;min-width:44px;flex-shrink:0;cursor:pointer;transition:border-color .12s}
.wavr-root .mixer-strip:hover{border-color:var(--br2)}
.wavr-root .mixer-strip.active{border-color:var(--ac)}
.wavr-root .fader{-webkit-appearance:none;writing-mode:vertical-lr;direction:rtl;width:2px;height:48px;background:var(--sf4);border-radius:2px;outline:none;cursor:pointer}
.wavr-root .fader::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:6px;background:var(--ac);border-radius:3px;cursor:pointer}
.wavr-root .strip-name{font-size:8px;color:var(--mt);text-align:center;max-width:40px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wavr-root .strip-vol{font-size:8px;color:var(--tl);font-variant-numeric:tabular-nums}
.wavr-root .vu-bar{width:4px;height:48px;background:var(--sf4);border-radius:2px;overflow:hidden;display:flex;flex-direction:column-reverse}
.wavr-root .vu-fill{width:100%;border-radius:2px;height:0%;transition:height .05s}
/* VISUALIZER */
.wavr-root .visualizer{flex:1;display:flex;flex-direction:column;min-width:0}
.wavr-root .vis-tabs{display:flex;gap:1px;padding:6px 8px 0;flex-shrink:0}
.wavr-root .vis-tab{padding:3px 10px;border-radius:4px 4px 0 0;font-size:9px;letter-spacing:.5px;cursor:pointer;color:var(--mt);border:1px solid transparent;border-bottom:none;transition:all .12s}
.wavr-root .vis-tab.active{background:var(--sf2);color:var(--tx);border-color:var(--br2)}
.wavr-root .vis-canvas-wrap{flex:1;position:relative;background:var(--sf2);margin:0 8px 6px;border-radius:0 5px 5px 5px;overflow:hidden;border:1px solid var(--br)}
.wavr-root .vis-canvas-wrap canvas{width:100%;height:100%;display:block}
/* EQ */
.wavr-root .eq-panel{flex-shrink:0;background:var(--sf2);border-left:1px solid var(--br2);width:280px;display:flex;flex-direction:column;overflow:hidden}
.wavr-root .eq-header{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-bottom:1px solid var(--br);flex-shrink:0}
.wavr-root .eq-header span:first-child{font-family:'Syne',sans-serif;font-size:11px;font-weight:700}
.wavr-root .eq-track-label{font-size:9px;color:var(--ac)}
.wavr-root .eq-canvas-wrap{flex:1;padding:4px 6px;position:relative}
.wavr-root .eq-canvas-wrap canvas{width:100%;height:100%;display:block;cursor:crosshair}
.wavr-root .eq-bands{display:flex;gap:4px;padding:4px 8px 6px;flex-shrink:0;overflow-x:auto}
.wavr-root .eq-bands::-webkit-scrollbar{display:none}
.wavr-root .eq-band{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:40px}
.wavr-root .eq-band label{font-size:8px;color:var(--mt);letter-spacing:.5px}
.wavr-root .eq-knob{width:30px;height:30px;border-radius:50%;background:var(--sf3);border:1px solid var(--br2);cursor:pointer;position:relative;touch-action:none;flex-shrink:0}
.wavr-root .eq-knob-dot{position:absolute;top:4px;left:50%;transform:translateX(-50%);width:2px;height:8px;background:var(--ac);border-radius:2px;transform-origin:50% 200%}
.wavr-root .eq-gain-label{font-size:8px;color:var(--tl);font-variant-numeric:tabular-nums;min-width:28px;text-align:center}
.wavr-root .eq-bypass{width:16px;height:16px;border-radius:3px;background:var(--sf3);border:1px solid var(--br2);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:7px;color:var(--mt);transition:all .1s}
.wavr-root .eq-bypass.active{background:var(--ac);border-color:var(--ac);color:#fff}
/* MODALS */
.wavr-root .modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:500;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)}
.wavr-root .modal{background:var(--sf2);border:1px solid var(--br3);border-radius:10px;padding:20px;min-width:300px;max-width:440px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.wavr-root .modal h3{font-family:'Syne',sans-serif;font-size:14px;font-weight:700;margin-bottom:12px}
.wavr-root .modal-row{display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.wavr-root .modal-btn{flex:1;padding:8px 12px;border-radius:6px;border:1px solid var(--br2);background:var(--sf3);color:var(--tx);font-family:inherit;font-size:10px;cursor:pointer;transition:all .12s;min-width:80px}
.wavr-root .modal-btn:hover{background:var(--sf4);border-color:var(--ac);color:var(--ac)}
.wavr-root .modal-btn.primary{background:var(--ac);border-color:var(--ac);color:#fff}
.wavr-root .modal-btn.primary:hover{opacity:.85}
.wavr-root .modal-btn.danger{background:rgba(225,112,85,.12);border-color:rgba(225,112,85,.4);color:var(--rd)}
.wavr-root .modal-btn.danger:hover{background:var(--rd);color:#fff}
.wavr-root .modal p{font-size:10px;color:var(--mt);margin-bottom:12px;line-height:1.6}
.wavr-root .modal-input{width:100%;background:var(--sf3);border:1px solid var(--br3);color:var(--tx);font-family:inherit;font-size:12px;padding:7px 10px;border-radius:6px;outline:none;margin-bottom:12px}
.wavr-root .modal-input:focus{border-color:var(--ac)}
/* SESSIONS */
.wavr-root .sessions-list{max-height:260px;overflow-y:auto;margin-bottom:12px}
.wavr-root .sessions-list::-webkit-scrollbar{width:4px}
.wavr-root .sessions-list::-webkit-scrollbar-thumb{background:var(--sf4)}
.wavr-root .session-item{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:5px;border:1px solid var(--br);margin-bottom:5px;transition:border-color .12s}
.wavr-root .session-item:hover{border-color:var(--ac)}
.wavr-root .si-name{font-size:11px;font-weight:600}
.wavr-root .si-date{font-size:9px;color:var(--mt)}
.wavr-root .si-load{padding:3px 8px;background:var(--ac);border:none;border-radius:4px;color:#fff;font-family:inherit;font-size:9px;cursor:pointer}
.wavr-root .si-del{padding:3px 8px;background:transparent;border:1px solid var(--br2);border-radius:4px;color:var(--rd);font-family:inherit;font-size:9px;cursor:pointer}
.wavr-root .si-del:hover{background:var(--rd);color:#fff}
/* HISTORY */
.wavr-root .history-panel{position:absolute;right:-260px;top:0;bottom:0;width:250px;background:var(--sf);border-left:1px solid var(--br2);z-index:200;transition:right .25s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column}
.wavr-root .history-panel.open{right:0}
.wavr-root .history-panel h4{font-family:'Syne',sans-serif;font-size:11px;font-weight:700;padding:10px 12px;border-bottom:1px solid var(--br);flex-shrink:0}
.wavr-root .hist-list{flex:1;overflow-y:auto;padding:4px}
.wavr-root .hist-list::-webkit-scrollbar{width:3px}
.wavr-root .hist-list::-webkit-scrollbar-thumb{background:var(--sf4)}
.wavr-root .hist-item{padding:6px 8px;border-radius:4px;cursor:pointer;font-size:9px;color:var(--mt);display:flex;align-items:center;gap:7px;transition:background .1s;border-left:2px solid transparent}
.wavr-root .hist-item:hover{background:var(--sf2);color:var(--tx)}
.wavr-root .hist-item.current{border-left-color:var(--ac);color:var(--tx);background:rgba(108,92,231,.07)}
.wavr-root .hi-action{flex:1}
.wavr-root .hi-time{font-size:8px;color:var(--dm)}
/* TOAST */
.wavr-root .toast{position:absolute;bottom:20px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--sf3);border:1px solid var(--br3);border-radius:6px;padding:7px 14px;font-size:10px;display:flex;align-items:center;gap:10px;z-index:400;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;white-space:nowrap}
.wavr-root .toast.show{opacity:1;transform:translateX(-50%) translateY(0);pointer-events:auto}
.wavr-root .toast button{background:var(--ac);border:none;color:#fff;border-radius:4px;padding:3px 8px;cursor:pointer;font-family:inherit;font-size:9px}
/* DROP OVERLAY */
.wavr-root .drop-overlay{position:absolute;inset:0;background:rgba(108,92,231,.1);border:2px dashed var(--ac);z-index:300;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;pointer-events:none}
.wavr-root .drop-title{font-family:'Syne',sans-serif;font-size:18px;font-weight:700;color:var(--ac)}
.wavr-root .drop-sub{font-size:10px;color:var(--mt)}
/* RESPONSIVE */
@media(max-width:900px){.wavr-root .eq-panel{display:none}}
@media(max-width:700px){
  .wavr-root{--hw:90px;--th:60px}
  .wavr-root .logo sup{display:none}
  .wavr-root .timecode{font-size:11px;padding:3px 6px;min-width:70px}
  .wavr-root .tbtn{width:24px;height:24px;font-size:11px}
  .wavr-root .bottom-panel{height:120px}
  .wavr-root .mixer-section{display:none}
}
@media(max-width:480px){
  .wavr-root{--hw:72px}
  .wavr-root .bpm-wrap{display:none}
}
`;

// ─── Sub-components ───────────────────────────────────────────

function WaveformCanvas({ buffer }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!buffer || !ref.current) return;
    const c = ref.current;
    const W = c.offsetWidth || 100, H = c.offsetHeight || 50;
    if (!W || !H) return;
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    const data = buffer.getChannelData(0);
    const step = Math.ceil(data.length / W);
    ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i < W; i++) {
      let mn = 1, mx = -1;
      for (let j = 0; j < step; j++) { const v = data[i*step+j]||0; if(v<mn)mn=v; if(v>mx)mx=v; }
      ctx.moveTo(i, ((1-mx)/2)*H); ctx.lineTo(i, ((1-mn)/2)*H);
    }
    ctx.stroke();
  }, [buffer]);
  return <canvas ref={ref} className="wf-canvas" />;
}

function Clip({ clip, track, selected, bpm, onMouseDown, onTouchStart, onContextMenu, onResizeMouseDown, onResizeTouchStart, onClick }) {
  const w = Math.max(b2x(clip.duration), 14);
  return (
    <div
      className={`clip${selected?" selected":""}`}
      style={{ left: b2x(clip.start), width: w, background: track.color }}
      data-cid={clip.id}
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
      onContextMenu={onContextMenu}
      onClick={onClick}
    >
      {clip.buffer && <WaveformCanvas buffer={clip.buffer} />}
      <span className="clip-label">{clip.name}</span>
      <div className="clip-resize" onMouseDown={onResizeMouseDown} onTouchStart={onResizeTouchStart} />
    </div>
  );
}

function EQPanel({ track, eqTrackId, onEQChange }) {
  const canvasRef = useRef(null);

  useEffect(() => { drawCurve(); }, [track]);

  function drawCurve() {
    const cvs = canvasRef.current; if (!cvs || !track?.eq) return;
    const p = cvs.parentElement; cvs.width = p.clientWidth||260; cvs.height = p.clientHeight||80;
    const W = cvs.width, H = cvs.height, ctx = cvs.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(255,255,255,.04)"; ctx.lineWidth = 1;
    [60,200,600,1800,5000,12000].forEach(f => {
      const x = freqToX(f,W); ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke();
    });
    [-12,-6,0,6,12].forEach(db => {
      const y = dbToY(db,H); ctx.strokeStyle = db===0?"rgba(255,255,255,.1)":"rgba(255,255,255,.04)";
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
    });
    const gains = new Float32Array(W);
    track.eq.forEach(b => {
      if (!b.enabled || b.gain===0) return;
      for (let i=0;i<W;i++) gains[i] += approxBiquad(b, xToFreq(i,W));
    });
    ctx.beginPath(); ctx.strokeStyle = "rgba(108,92,231,.9)"; ctx.lineWidth = 2;
    for (let i=0;i<W;i++) { const y=dbToY(gains[i],H); i===0?ctx.moveTo(i,y):ctx.lineTo(i,y); }
    ctx.stroke();
    ctx.fillStyle = "rgba(108,92,231,.12)";
    ctx.lineTo(W,H/2); ctx.lineTo(0,H/2); ctx.fill();
    track.eq.forEach(b => {
      const x=freqToX(b.freq,W), y=dbToY(b.enabled?b.gain:0,H);
      ctx.beginPath(); ctx.arc(x,y,4,0,Math.PI*2);
      ctx.fillStyle = b.enabled?"#6c5ce7":"#666688"; ctx.fill();
    });
  }

  const freqToX = (f,W) => (Math.log10(f/20)/Math.log10(22000/20))*W;
  const xToFreq = (x,W) => 20*Math.pow(22000/20,x/W);
  const dbToY   = (db,H) => H/2-(db/18)*(H/2)*0.9;

  const handleKnobDrag = useCallback((bandIdx) => {
    let startY, startGain;
    const onMove = e => {
      const cy = e.touches ? e.touches[0].clientY : e.clientY;
      const newGain = clamp(startGain + (startY-cy)*0.3, -18, 18);
      onEQChange(bandIdx, "gain", newGain);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onUp);
    };
    return {
      onMouseDown: e => { startY=e.clientY; startGain=track.eq[bandIdx].gain; document.addEventListener("mousemove",onMove); document.addEventListener("mouseup",onUp); },
      onTouchStart: e => { startY=e.touches[0].clientY; startGain=track.eq[bandIdx].gain; document.addEventListener("touchmove",onMove,{passive:false}); document.addEventListener("touchend",onUp); }
    };
  }, [track, onEQChange]);

  if (!track) return (
    <div className="eq-panel">
      <div className="eq-header"><span>EQ</span><span className="eq-track-label">— no track —</span></div>
    </div>
  );

  return (
    <div className="eq-panel">
      <div className="eq-header">
        <span>EQ</span>
        <span className="eq-track-label">{track.name}</span>
      </div>
      <div className="eq-canvas-wrap">
        <canvas ref={canvasRef} />
      </div>
      <div className="eq-bands">
        {track.eq.map((b, i) => {
          const drag = handleKnobDrag(i);
          const rot = b.gain * 5;
          return (
            <div key={i} className="eq-band">
              <label>{b.label}</label>
              <div className="eq-knob" style={{ transform:`rotate(${rot}deg)` }} {...drag}>
                <div className="eq-knob-dot" />
              </div>
              <div className="eq-gain-label">{(b.gain>=0?"+":"")+b.gain.toFixed(1)}dB</div>
              <div className={`eq-bypass${b.enabled?" active":""}`} onClick={() => onEQChange(i,"enabled",!b.enabled)}>
                {b.enabled?"●":"○"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────
export default function WavrPro() {
  // ── State
  const [tracks,      setTracks]      = useState([]);
  const [bpm,         setBpm]         = useState(120);
  const [totalBeats,  setTotalBeats]  = useState(96);
  const [isPlaying,   setIsPlaying]   = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [timecode,    setTimecode]    = useState("0:00.000");
  const [selectedClipId,  setSelectedClipId]  = useState(null);
  const [selectedTrackId, setSelectedTrackId] = useState(null);
  const [eqTrackId,       setEqTrackId]       = useState(null);
  const [activeVisMode,   setActiveVisMode]   = useState("waveform");
  const [showCtxMenu,     setShowCtxMenu]     = useState(false);
  const [ctxMenuPos,      setCtxMenuPos]      = useState({ x:0, y:0 });
  const [ctxClip,         setCtxClip]         = useState(null);
  const [ctxTrack,        setCtxTrack]        = useState(null);
  const [showHistory,     setShowHistory]     = useState(false);
  const [historyItems,    setHistoryItems]    = useState([]);
  const [historyIdx,      setHistoryIdx]      = useState(-1);
  const [toast,           setToast]           = useState({ show:false, msg:"", showRedo:false });
  const [showDrop,        setShowDrop]        = useState(false);
  const [exportState,     setExportState]     = useState({ show:false, pct:0, status:"" });
  const [ctxNotice,       setCtxNotice]       = useState(false);
  const [modal,           setModal]           = useState(null); // { type, data }
  const [sessionsList,    setSessionsList]    = useState([]);

  // ── Refs (mutable, no re-render)
  const audioCtxRef    = useRef(null);
  const masterGainRef  = useRef(null);
  const masterAnRef    = useRef(null);
  const tracksRef      = useRef(tracks);
  const bpmRef         = useRef(bpm);
  const totalBeatsRef  = useRef(totalBeats);
  const playOffsetRef  = useRef(0);
  const playStartRef   = useRef(0);
  const isPlayingRef   = useRef(false);
  const scheduledRef   = useRef([]);
  const animRef        = useRef(null);
  const vuRef          = useRef(null);
  const visRef         = useRef(null);
  const scrollRef      = useRef(null);
  const rulerRef       = useRef(null);
  const thScrollRef    = useRef(null);
  const playheadRef    = useRef(null);
  const visCanvasRef   = useRef(null);
  const recordStreamRef= useRef(null);
  const mediaRecRef    = useRef(null);
  const recTrackIdRef  = useRef(null);
  const historyRef     = useRef([]);
  const histIdxRef     = useRef(-1);
  const toastTimerRef  = useRef(null);
  const vuFillsRef     = useRef({});
  const spectroRef     = useRef([]);
  const scrollVRef     = useRef({ x:0, y:0, lastX:0, lastY:0, lastT:0, dragging:false });
  const scrollRafRef   = useRef(null);

  // Keep refs in sync with state
  useEffect(() => { tracksRef.current = tracks; }, [tracks]);
  useEffect(() => { bpmRef.current = bpm; }, [bpm]);
  useEffect(() => { totalBeatsRef.current = totalBeats; }, [totalBeats]);

  // ── Audio context
  function getCtx() {
    if (!audioCtxRef.current) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtxRef.current = ctx;
      masterGainRef.current = ctx.createGain(); masterGainRef.current.gain.value = 0.9;
      masterAnRef.current = ctx.createAnalyser(); masterAnRef.current.fftSize = 2048;
      masterGainRef.current.connect(masterAnRef.current); masterAnRef.current.connect(ctx.destination);
    }
    setCtxNotice(audioCtxRef.current.state === "suspended");
    return audioCtxRef.current;
  }

  // ── History
  const snapshot = useCallback((action) => {
    const state = JSON.stringify(tracksRef.current.map(t => ({
      id:t.id, name:t.name, color:t.color, muted:t.muted, solo:t.solo,
      armed:t.armed, volume:t.volume,
      clips: t.clips.map(c => ({ id:c.id, name:c.name, start:c.start, duration:c.duration, hasBuffer:!!c.buffer })),
      eq: t.eq ? t.eq.map(b => ({...b})) : null
    })));
    let hist = historyRef.current;
    const idx = histIdxRef.current;
    if (idx < hist.length-1) hist = hist.slice(0, idx+1);
    hist = [...hist, { action, state, time: Date.now() }];
    if (hist.length > MAX_HISTORY) hist = hist.slice(hist.length - MAX_HISTORY);
    historyRef.current = hist;
    histIdxRef.current = hist.length - 1;
    setHistoryItems([...hist]);
    setHistoryIdx(hist.length - 1);
  }, []);

  function restoreSnapshot(idx) {
    const s = historyRef.current[idx]; if (!s) return;
    const parsed = JSON.parse(s.state);
    const bufMap = {};
    tracksRef.current.forEach(t => t.clips.forEach(c => { if (c.buffer) bufMap[c.id] = c.buffer; }));
    const restored = parsed.map(td => ({
      ...td, gainNode:null, vuAnalyser:null, eqNodes:null,
      eq: td.eq || defaultEQ(),
      clips: td.clips.map(cd => ({ ...cd, buffer: bufMap[cd.id] || null }))
    }));
    histIdxRef.current = idx;
    setHistoryIdx(idx);
    setTracks(restored);
  }

  const showToast = useCallback((msg, showRedo) => {
    setToast({ show:true, msg, showRedo });
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(t => ({...t, show:false})), 3000);
  }, []);

  const undo = useCallback(() => {
    const idx = histIdxRef.current;
    if (idx <= 0) return;
    restoreSnapshot(idx - 1);
    showToast("Undone: " + (historyRef.current[idx]?.action||""), true);
  }, [showToast]);

  const redo = useCallback(() => {
    const idx = histIdxRef.current;
    if (idx >= historyRef.current.length-1) return;
    restoreSnapshot(idx + 1);
    showToast("Redone: " + (historyRef.current[idx+1]?.action||""), false);
  }, [showToast]);

  // ── Track helpers
  const mkTrack = useCallback((name, color) => {
    const id = uid();
    return { id, name: name||("Track "+(tracksRef.current.length+1)), color: color||COLORS[tracksRef.current.length%COLORS.length], clips:[], muted:false, solo:false, armed:false, volume:0.8, gainNode:null, vuAnalyser:null, eqNodes:null, eq:defaultEQ() };
  }, []);

  const addTrack = useCallback((name, color) => {
    const t = mkTrack(name, color);
    setTracks(prev => { tracksRef.current = [...prev, t]; return [...prev, t]; });
    return t;
  }, [mkTrack]);

  // ── Scroll sync
  useEffect(() => {
    const sc = scrollRef.current; if (!sc) return;
    const onScroll = () => {
      if (rulerRef.current) rulerRef.current.style.transform = `translateX(${-sc.scrollLeft}px)`;
      if (thScrollRef.current) thScrollRef.current.style.marginTop = -sc.scrollTop + "px";
      syncPlayhead();
    };
    sc.addEventListener("scroll", onScroll, { passive:true });

    const sv = scrollVRef.current;
    const onPD = e => {
      if (e.button!==1 && e.pointerType!=="touch" && !e.altKey) return;
      e.preventDefault(); sv.dragging=true; sv.x=0; sv.y=0;
      sv.lastX=e.clientX; sv.lastY=e.clientY; sv.lastT=performance.now();
      sc.setPointerCapture(e.pointerId); sc.style.cursor="grabbing";
    };
    const onPM = e => {
      if (!sv.dragging) return;
      const now=performance.now(), dt=now-sv.lastT||1;
      const dx=sv.lastX-e.clientX, dy=sv.lastY-e.clientY;
      sv.x=dx/dt*16; sv.y=dy/dt*16;
      sc.scrollLeft+=dx; sc.scrollTop+=dy;
      sv.lastX=e.clientX; sv.lastY=e.clientY; sv.lastT=now;
    };
    const onPU = () => {
      if (!sv.dragging) return; sv.dragging=false; sc.style.cursor="";
      cancelAnimationFrame(scrollRafRef.current);
      const step = () => {
        if (Math.abs(sv.x)<0.15 && Math.abs(sv.y)<0.15) return;
        sc.scrollLeft+=sv.x; sc.scrollTop+=sv.y; sv.x*=0.87; sv.y*=0.87;
        scrollRafRef.current = requestAnimationFrame(step);
      };
      scrollRafRef.current = requestAnimationFrame(step);
    };
    sc.addEventListener("pointerdown",onPD); sc.addEventListener("pointermove",onPM); sc.addEventListener("pointerup",onPU);

    const syncLoop = () => { if (rulerRef.current && sc) rulerRef.current.style.transform=`translateX(${-sc.scrollLeft}px)`; requestAnimationFrame(syncLoop); };
    requestAnimationFrame(syncLoop);
    return () => { sc.removeEventListener("scroll",onScroll); sc.removeEventListener("pointerdown",onPD); sc.removeEventListener("pointermove",onPM); sc.removeEventListener("pointerup",onPU); };
  }, []);

  // ── Ruler canvas
  useEffect(() => {
    const cvs = rulerRef.current; if (!cvs) return;
    const W = totalW(totalBeats); cvs.width = W; cvs.height = 26; cvs.style.width = W+"px";
    const ctx = cvs.getContext("2d"); ctx.clearRect(0,0,W,26);
    for (let b=0; b<totalBeats; b++) {
      const x = b2x(b);
      if (b%4===0) { ctx.fillStyle="rgba(255,255,255,.09)"; ctx.fillRect(x,16,1,10); ctx.fillStyle="#55556a"; ctx.font="9px JetBrains Mono,monospace"; ctx.fillText(String(Math.floor(b/4)+1),x+2,12); }
      else if (b%2===0) { ctx.fillStyle="rgba(255,255,255,.04)"; ctx.fillRect(x,20,1,6); }
      else { ctx.fillStyle="rgba(255,255,255,.025)"; ctx.fillRect(x,22,1,4); }
    }
  }, [totalBeats]);

  // ── Playhead
  function syncPlayhead() {
    const ph = playheadRef.current; if (!ph) return;
    ph.style.transform = `translateX(${b2x(currentBeat())}px)`;
    ph.style.height = (tracksRef.current.length * 72 + 60) + "px";
  }
  function currentBeat() {
    if (!isPlayingRef.current) return playOffsetRef.current;
    const ctx = audioCtxRef.current; if (!ctx) return playOffsetRef.current;
    return s2b(ctx.currentTime - playStartRef.current, bpmRef.current) + playOffsetRef.current;
  }
  function fmtTimecode(beat) {
    const sec = b2s(beat, bpmRef.current);
    return `${Math.floor(sec/60)}:${(sec%60).toFixed(3).padStart(6,"0")}`;
  }

  // ── Transport
  const startPlayback = useCallback(() => {
    const ctx = getCtx();
    ctx.resume().then(() => setCtxNotice(false));
    isPlayingRef.current = true; playStartRef.current = ctx.currentTime;
    setIsPlaying(true);
    const hasSolo = tracksRef.current.some(t => t.solo);
    tracksRef.current.forEach(t => {
      if (t.muted || (hasSolo&&!t.solo) || !t.clips.length) return;
      const gain = ctx.createGain(); gain.gain.value = t.volume; t.gainNode = gain;
      const an = ctx.createAnalyser(); an.fftSize = 256; t.vuAnalyser = an;
      if (t.eq && t.eq.some(b => b.gain!==0 && b.enabled)) {
        t.eqNodes = buildEQChain(ctx, masterGainRef.current, t.eq);
        gain.connect(t.eqNodes[0]);
      } else { t.eqNodes = null; gain.connect(masterGainRef.current); }
      gain.connect(an);
      t.clips.forEach(clip => {
        if (!clip.buffer) return;
        const src = ctx.createBufferSource(); src.buffer = clip.buffer; src.connect(gain);
        const cs = b2s(clip.start - playOffsetRef.current, bpmRef.current);
        const when = cs>0 ? ctx.currentTime+cs : ctx.currentTime;
        const off  = cs<0 ? clamp(-cs,0,clip.buffer.duration-0.001) : 0;
        try { src.start(when, off); } catch(e){}
        scheduledRef.current.push(src);
      });
    });
    startVU(); startVis();
    const loop = () => {
      syncPlayhead();
      const beat = currentBeat();
      setTimecode(fmtTimecode(beat));
      if (beat >= totalBeatsRef.current) { stopPlayback(); return; }
      animRef.current = requestAnimationFrame(loop);
    };
    animRef.current = requestAnimationFrame(loop);
  }, []);

  const stopPlayback = useCallback(() => {
    isPlayingRef.current = false;
    cancelAnimationFrame(animRef.current); cancelAnimationFrame(vuRef.current);
    scheduledRef.current.forEach(s => { try{s.stop();}catch(e){} }); scheduledRef.current = [];
    tracksRef.current.forEach(t => { t.gainNode=null; t.vuAnalyser=null; t.eqNodes=null; });
    setIsPlaying(false); setIsRecording(false);
    syncPlayhead(); setTimecode(fmtTimecode(playOffsetRef.current));
    Object.values(vuFillsRef.current).forEach(el => { if(el) el.style.height="0%"; });
  }, []);

  const rewind = useCallback(() => {
    stopPlayback(); playOffsetRef.current = 0; syncPlayhead(); setTimecode("0:00.000");
  }, [stopPlayback]);

  // ── VU
  function startVU() {
    cancelAnimationFrame(vuRef.current);
    const loop = () => {
      tracksRef.current.forEach(t => {
        const el = vuFillsRef.current[t.id]; if (!el) return;
        if (!t.vuAnalyser) { el.style.height="0%"; return; }
        const buf = new Uint8Array(t.vuAnalyser.frequencyBinCount);
        t.vuAnalyser.getByteTimeDomainData(buf);
        let max=0; for(let i=0;i<buf.length;i++){const v=Math.abs(buf[i]-128)/128; if(v>max)max=v;}
        el.style.height = clamp(max*150,0,100)+"%";
      });
      vuRef.current = requestAnimationFrame(loop);
    };
    loop();
  }

  // ── Visualizer
  function startVis() {
    cancelAnimationFrame(visRef.current);
    const loop = () => { drawVis(); visRef.current = requestAnimationFrame(loop); };
    loop();
  }
  function drawVis() {
    const cvs = visCanvasRef.current; if (!cvs || !masterAnRef.current) return;
    const wrap = cvs.parentElement; const W=wrap.clientWidth||400, H=wrap.clientHeight||90;
    if (cvs.width!==W||cvs.height!==H){cvs.width=W;cvs.height=H;}
    const ctx = cvs.getContext("2d");
    const mode = activeVisMode;
    if (mode==="waveform")    drawWaveform(ctx,W,H);
    else if (mode==="spectrum")    drawSpectrum(ctx,W,H);
    else if (mode==="spectrogram") drawSpectrogram(ctx,W,H);
    else if (mode==="oscilloscope")drawScope(ctx,W,H);
    else if (mode==="lissajous")   drawLissajous(ctx,W,H);
  }
  function drawWaveform(ctx,W,H){
    ctx.clearRect(0,0,W,H);
    const buf=new Uint8Array(masterAnRef.current.fftSize); masterAnRef.current.getByteTimeDomainData(buf);
    ctx.strokeStyle=COLORS[0]; ctx.lineWidth=1.5; ctx.beginPath();
    const sl=W/buf.length;
    for(let i=0;i<buf.length;i++){const y=(buf[i]/128-1)*(H/2)+H/2; i===0?ctx.moveTo(0,y):ctx.lineTo(i*sl,y);}
    ctx.stroke();
    ctx.strokeStyle="rgba(255,255,255,.07)"; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(0,H/2); ctx.lineTo(W,H/2); ctx.stroke();
  }
  function drawSpectrum(ctx,W,H){
    ctx.clearRect(0,0,W,H);
    const N=masterAnRef.current.frequencyBinCount;
    const buf=new Uint8Array(N); masterAnRef.current.getByteFrequencyData(buf);
    const bW=W/(N/2);
    const grad=ctx.createLinearGradient(0,H,0,0);
    grad.addColorStop(0,COLORS[0]); grad.addColorStop(.5,COLORS[1]); grad.addColorStop(1,COLORS[3]);
    ctx.fillStyle=grad;
    for(let i=0;i<N/2;i++){const h=(buf[i]/255)*H; ctx.fillRect(i*bW,H-h,Math.max(bW-1,1),h);}
  }
  function drawSpectrogram(ctx,W,H){
    const N=masterAnRef.current.frequencyBinCount;
    const buf=new Uint8Array(N); masterAnRef.current.getByteFrequencyData(buf);
    const col=new Uint8ClampedArray(H*4);
    for(let i=0;i<H;i++){const fi=Math.floor((1-i/H)*N/2); const v=buf[fi]/255; col[i*4]=v*108;col[i*4+1]=v*200;col[i*4+2]=v*240;col[i*4+3]=255;}
    spectroRef.current.push(col); if(spectroRef.current.length>W) spectroRef.current.shift();
    const img=ctx.createImageData(W,H);
    spectroRef.current.forEach((c,xi)=>{for(let y=0;y<H;y++){const pi=(y*W+xi)*4; img.data[pi]=c[y*4];img.data[pi+1]=c[y*4+1];img.data[pi+2]=c[y*4+2];img.data[pi+3]=255;}});
    ctx.putImageData(img,0,0);
  }
  function drawScope(ctx,W,H){
    ctx.clearRect(0,0,W,H);
    const buf=new Uint8Array(masterAnRef.current.fftSize); masterAnRef.current.getByteTimeDomainData(buf);
    let start=0; for(let i=0;i<buf.length-1;i++){if(buf[i]<128&&buf[i+1]>=128){start=i;break;}}
    const len=Math.min(buf.length-start,W);
    ctx.strokeStyle=COLORS[4]; ctx.lineWidth=1.5; ctx.beginPath();
    for(let i=0;i<len;i++){const y=(buf[start+i]/128-1)*(H*.45)+H/2; i===0?ctx.moveTo(i,y):ctx.lineTo(i,y);}
    ctx.stroke();
    ctx.strokeStyle="rgba(255,255,255,.04)"; ctx.lineWidth=1;
    [H*.25,H*.5,H*.75].forEach(y=>{ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();});
    [W*.25,W*.5,W*.75].forEach(x=>{ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();});
  }
  function drawLissajous(ctx,W,H){
    ctx.fillStyle="rgba(8,8,16,.15)"; ctx.fillRect(0,0,W,H);
    const buf=new Float32Array(masterAnRef.current.fftSize); masterAnRef.current.getFloatTimeDomainData(buf);
    const cx=W/2,cy=H/2,r=Math.min(W,H)*.42,half=Math.floor(buf.length/2);
    ctx.strokeStyle=COLORS[5]; ctx.lineWidth=1; ctx.globalAlpha=0.8; ctx.beginPath();
    for(let i=0;i<half-1;i++){const x=cx+buf[i]*r,y=cy+buf[i+half]*r; i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);}
    ctx.stroke(); ctx.globalAlpha=1;
  }

  // idle vis loop
  useEffect(() => {
    let raf;
    const loop = () => { if (!isPlayingRef.current) drawVis(); raf=requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [activeVisMode]);

  // ── Clip drag
  function makeDragHandler(track, clip) {
    let sx, sb, dragging=false;
    const onMove = e => {
      if (!dragging) return;
      const cx = e.touches?e.touches[0].clientX:e.clientX;
      clip.start = Math.max(0, sb + x2b(cx-sx));
      const el = document.querySelector(`[data-cid="${clip.id}"]`);
      if (el) el.style.left = b2x(clip.start)+"px";
    };
    const onUp = () => {
      if (!dragging) return; dragging=false;
      document.removeEventListener("mousemove",onMove); document.removeEventListener("mouseup",onUp);
      document.removeEventListener("touchmove",onMove); document.removeEventListener("touchend",onUp);
      setTracks([...tracksRef.current]); snapshot("Move clip");
    };
    return {
      onMouseDown: e => {
        if (e.button!==0||e.target.classList.contains("clip-resize")) return;
        e.preventDefault(); e.stopPropagation(); dragging=true; sx=e.clientX; sb=clip.start;
        setSelectedClipId(clip.id); setSelectedTrackId(track.id); setEqTrackId(track.id);
        document.addEventListener("mousemove",onMove); document.addEventListener("mouseup",onUp);
      },
      onTouchStart: e => {
        if (e.target.classList.contains("clip-resize")) return;
        dragging=true; sx=e.touches[0].clientX; sb=clip.start;
        document.addEventListener("touchmove",onMove,{passive:true}); document.addEventListener("touchend",onUp);
      }
    };
  }

  function makeResizeHandler(track, clip) {
    let sx, sd, resizing=false;
    const onMove = e => {
      if (!resizing) return;
      const cx = e.touches?e.touches[0].clientX:e.clientX;
      clip.duration = Math.max(0.5, sd + x2b(cx-sx));
      const el = document.querySelector(`[data-cid="${clip.id}"]`);
      if (el) el.style.width = Math.max(b2x(clip.duration),14)+"px";
    };
    const onUp = () => {
      if (!resizing) return; resizing=false;
      document.removeEventListener("mousemove",onMove); document.removeEventListener("mouseup",onUp);
      document.removeEventListener("touchmove",onMove); document.removeEventListener("touchend",onUp);
      setTracks([...tracksRef.current]); snapshot("Resize clip");
    };
    return {
      onMouseDown: e => { e.preventDefault(); e.stopPropagation(); resizing=true; sx=e.clientX; sd=clip.duration; document.addEventListener("mousemove",onMove); document.addEventListener("mouseup",onUp); },
      onTouchStart: e => { e.stopPropagation(); resizing=true; sx=e.touches[0].clientX; sd=clip.duration; document.addEventListener("touchmove",onMove,{passive:false}); document.addEventListener("touchend",onUp); }
    };
  }

  // ── Synth clip
  const dropSynth = useCallback((track, beat) => {
    const ctx = getCtx(); const dur = b2s(4, bpmRef.current);
    const off = new OfflineAudioContext(1, Math.ceil(ctx.sampleRate*dur), ctx.sampleRate);
    const idx = COLORS.indexOf(track.color);
    const freq = BASE_FREQS[idx>=0?idx:0] * (1+track.clips.length*0.14);
    const osc = off.createOscillator(); osc.frequency.value=freq; osc.type=OSC_TYPES[idx%OSC_TYPES.length]||"sawtooth";
    const g = off.createGain(); g.gain.setValueAtTime(.38,0); g.gain.exponentialRampToValueAtTime(.001,dur*.9);
    osc.connect(g); g.connect(off.destination); osc.start(0); osc.stop(dur);
    off.startRendering().then(buf => {
      const newClip = { id:uid(), name:"Clip "+(track.clips.length+1), start:beat, duration:4, buffer:buf };
      const updated = tracksRef.current.map(t => t.id===track.id ? {...t, clips:[...t.clips, newClip]} : t);
      const newTotal = Math.max(totalBeatsRef.current, Math.ceil(beat+8));
      setTotalBeats(newTotal); setTracks(updated); snapshot("Add synth clip");
    });
  }, [snapshot]);

  // ── Import
  const loadFilesAsNewTracks = useCallback((files) => {
    const ctx = getCtx(); ctx.resume();
    Array.from(files).filter(f=>f.type.startsWith("audio/")||/\.(wav|mp3|ogg|flac|aac|m4a)$/i.test(f.name)).forEach(file=>{
      const reader = new FileReader();
      reader.onload = ev => {
        ctx.decodeAudioData(ev.target.result.slice(0)).then(buf=>{
          const t = { id:uid(), name:file.name.replace(/\.[^/.]+$/,""), color:COLORS[tracksRef.current.length%COLORS.length], clips:[{id:uid(),name:"Audio",start:0,duration:s2b(buf.duration,bpmRef.current),buffer:buf}], muted:false,solo:false,armed:false,volume:0.8,gainNode:null,vuAnalyser:null,eqNodes:null,eq:defaultEQ() };
          const updated = [...tracksRef.current, t];
          const newTotal = Math.max(totalBeatsRef.current, Math.ceil(s2b(buf.duration,bpmRef.current)+4));
          setTracks(updated); setTotalBeats(newTotal); snapshot("Import audio");
        }).catch(()=>alert("Could not decode: "+file.name));
      };
      reader.readAsArrayBuffer(file);
    });
  }, [snapshot]);

  const loadFilesIntoTrack = useCallback((track, files, startBeat) => {
    const ctx = getCtx(); ctx.resume();
    Array.from(files).forEach(file=>{
      const reader=new FileReader();
      reader.onload=ev=>{
        ctx.decodeAudioData(ev.target.result.slice(0)).then(buf=>{
          const dur=s2b(buf.duration,bpmRef.current);
          const newClip={id:uid(),name:file.name.replace(/\.[^/.]+$/,""),start:startBeat,duration:dur,buffer:buf};
          const updated=tracksRef.current.map(t=>t.id===track.id?{...t,clips:[...t.clips,newClip]}:t);
          setTracks(updated); setTotalBeats(Math.max(totalBeatsRef.current,Math.ceil(startBeat+dur+4))); snapshot("Import into track");
        });
      };
      reader.readAsArrayBuffer(file);
    });
  }, [snapshot]);

  // ── Export
  const exportMix = useCallback(async () => {
    if (!tracksRef.current.some(t=>t.clips.some(c=>c.buffer))){ alert("Nothing to export."); return; }
    setExportState({ show:true, pct:0, status:"Rendering…" });
    const SR=44100, totalSec=b2s(totalBeatsRef.current,bpmRef.current), length=Math.ceil(SR*totalSec);
    const offCtx=new OfflineAudioContext(2,length,SR);
    const hasSolo=tracksRef.current.some(t=>t.solo);
    tracksRef.current.forEach(t=>{
      if (t.muted||(hasSolo&&!t.solo)) return;
      const gain=offCtx.createGain(); gain.gain.value=t.volume;
      let dest=offCtx.destination;
      if (t.eq&&t.eq.some(b=>b.gain!==0&&b.enabled)){const eq=buildEQChain(offCtx,dest,t.eq);dest=eq[0];} 
      gain.connect(dest);
      t.clips.forEach(clip=>{
        if (!clip.buffer) return;
        const src=offCtx.createBufferSource();
        if (clip.buffer.sampleRate!==SR){
          const rs=offCtx.createBuffer(clip.buffer.numberOfChannels,Math.ceil(clip.buffer.duration*SR),SR);
          for(let ch=0;ch<clip.buffer.numberOfChannels;ch++){const o=clip.buffer.getChannelData(ch),d=rs.getChannelData(ch),r=clip.buffer.sampleRate/SR; for(let i=0;i<d.length;i++) d[i]=o[Math.min(Math.round(i*r),o.length-1)]||0;}
          src.buffer=rs;
        } else src.buffer=clip.buffer;
        src.connect(gain); src.start(b2s(clip.start,bpmRef.current));
      });
    });
    let fp=0; const fi=setInterval(()=>{fp=Math.min(fp+1.5,88); setExportState(s=>({...s,pct:Math.round(fp)}));},80);
    let rendered;
    try{rendered=await offCtx.startRendering();}catch(e){clearInterval(fi);setExportState({show:false,pct:0,status:""});alert("Export failed: "+e.message);return;}
    clearInterval(fi); setExportState({show:true,pct:100,status:"Done!"});
    setTimeout(()=>setExportState({show:false,pct:0,status:""}),2500);
    const wav=encodeWAV(rendered);
    const blob=new Blob([wav],{type:"audio/wav"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=url; a.download="wavr-mix.wav"; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),10000);
  }, []);

  // ── Recording
  const reqMic = useCallback(() => {
    if (!navigator.mediaDevices?.getUserMedia){alert("Microphone unavailable.");return;}
    navigator.mediaDevices.getUserMedia({audio:true}).then(s=>{recordStreamRef.current=s;}).catch(()=>alert("Mic permission denied."));
  }, []);

  const startRecording = useCallback(() => {
    const armed=tracksRef.current.find(t=>t.armed);
    if (!armed){alert("Arm a track first (R button).");return;}
    if (!recordStreamRef.current){alert("Mic not ready — click R first.");return;}
    const ctx=getCtx(); ctx.resume();
    const chunks=[];
    const mr=new MediaRecorder(recordStreamRef.current);
    mr.ondataavailable=e=>chunks.push(e.data);
    mr.onstop=()=>{
      const blob=new Blob(chunks,{type:"audio/ogg; codecs=opus"});
      const reader=new FileReader();
      reader.onload=ev=>{
        ctx.decodeAudioData(ev.target.result).then(buf=>{
          const dur=s2b(buf.duration,bpmRef.current);
          const newClip={id:uid(),name:"Rec "+(armed.clips.length+1),start:playOffsetRef.current,duration:dur,buffer:buf};
          const updated=tracksRef.current.map(t=>t.id===armed.id?{...t,clips:[...t.clips,newClip]}:t);
          setTracks(updated); setTotalBeats(Math.max(totalBeatsRef.current,Math.ceil(playOffsetRef.current+dur+4)));
          snapshot("Record audio");
        }).catch(e=>alert("Could not decode recording: "+e.message));
      };
      reader.readAsArrayBuffer(blob);
      mediaRecRef.current=null; recTrackIdRef.current=null; setIsRecording(false);
    };
    mediaRecRef.current=mr; recTrackIdRef.current=armed.id; mr.start();
    setIsRecording(true); startPlayback();
  }, [snapshot, startPlayback]);

  // ── Context menu actions
  const cmDelete = () => {
    if (!ctxClip||!ctxTrack) return;
    snapshot("Delete clip");
    setTracks(prev => prev.map(t=>t.id===ctxTrack.id?{...t,clips:t.clips.filter(c=>c.id!==ctxClip.id)}:t));
    setShowCtxMenu(false);
  };
  const cmDuplicate = () => {
    if (!ctxClip||!ctxTrack) return;
    snapshot("Duplicate clip");
    const nc={...ctxClip,id:uid(),name:ctxClip.name+" copy",start:ctxClip.start+ctxClip.duration};
    setTracks(prev=>prev.map(t=>t.id===ctxTrack.id?{...t,clips:[...t.clips,nc]}:t));
    setTotalBeats(prev=>Math.max(prev,Math.ceil(nc.start+nc.duration+4)));
    setShowCtxMenu(false);
  };
  const cmRename = () => {
    setModal({ type:"rename", value:ctxClip?.name||"", onOk:(v)=>{
      if (!v||!ctxClip||!ctxTrack) return;
      snapshot("Rename clip");
      setTracks(prev=>prev.map(t=>t.id===ctxTrack.id?{...t,clips:t.clips.map(c=>c.id===ctxClip.id?{...c,name:v}:c)}:t));
    }});
    setShowCtxMenu(false);
  };
  const cmGain = () => {
    setModal({ type:"gain", onOk:(db)=>{
      if (!ctxClip?.buffer||!ctxTrack) return;
      const mul=Math.pow(10,db/20);
      const off=new OfflineAudioContext(ctxClip.buffer.numberOfChannels,ctxClip.buffer.length,ctxClip.buffer.sampleRate);
      const src=off.createBufferSource(); src.buffer=ctxClip.buffer;
      const g=off.createGain(); g.gain.value=mul; src.connect(g); g.connect(off.destination); src.start(0);
      off.startRendering().then(buf=>{
        snapshot("Clip gain");
        setTracks(prev=>prev.map(t=>t.id===ctxTrack.id?{...t,clips:t.clips.map(c=>c.id===ctxClip.id?{...c,buffer:buf}:c)}:t));
      });
    }});
    setShowCtxMenu(false);
  };
  const cmColor = () => {
    if (!ctxTrack) return;
    const curr=COLORS.indexOf(ctxTrack.color);
    snapshot("Change colour");
    setTracks(prev=>prev.map(t=>t.id===ctxTrack.id?{...t,color:COLORS[(curr+1)%COLORS.length]}:t));
    setShowCtxMenu(false);
  };
  const cmReplace = () => {
    const input=document.getElementById("wavr-replace-input"); if(input) input.click();
    setShowCtxMenu(false);
  };

  // ── EQ
  const handleEQChange = useCallback((trackId, bandIdx, key, value) => {
    setTracks(prev=>prev.map(t=>{
      if (t.id!==trackId) return t;
      const eq=[...t.eq]; eq[bandIdx]={...eq[bandIdx],[key]:value};
      if (t.eqNodes && t.eqNodes[bandIdx]) t.eqNodes[bandIdx].gain.value = (eq[bandIdx].enabled?eq[bandIdx].gain:0);
      return {...t,eq};
    }));
  }, []);

  // ── Session persistence
  const getSessionIndex = () => JSON.parse(localStorage.getItem("wavr-sessions")||"[]");

  const saveSession = async (name) => {
    const id="session_"+Date.now();
    const data={
      id, name, savedAt:Date.now(), bpm:bpmRef.current, totalBeats:totalBeatsRef.current,
      tracks:tracksRef.current.map(t=>({
        id:t.id,name:t.name,color:t.color,muted:t.muted,solo:t.solo,armed:t.armed,volume:t.volume,eq:t.eq,
        clips:t.clips.map(c=>({id:c.id,name:c.name,start:c.start,duration:c.duration,bufferRaw:c.buffer?bufferToRaw(c.buffer):null}))
      }))
    };
    await idbPut(data);
    const index=getSessionIndex();
    index.unshift({id,name,savedAt:data.savedAt});
    localStorage.setItem("wavr-sessions",JSON.stringify(index.slice(0,20)));
    showToast("Saved: "+name, false);
    setSessionsList(getSessionIndex());
  };

  const loadSessionById = async (id) => {
    const data=await idbGet(id);
    if (!data){alert("Session data not found (may have been cleared by browser).");return;}
    stopPlayback();
    const ctx=getCtx();
    setBpm(data.bpm||120); setTotalBeats(data.totalBeats||96);
    const loaded=data.tracks.map(td=>({
      ...td,gainNode:null,vuAnalyser:null,eqNodes:null,eq:td.eq||defaultEQ(),
      clips:td.clips.map(cd=>({...cd,buffer:cd.bufferRaw?rawToBuffer(cd.bufferRaw,ctx):null}))
    }));
    playOffsetRef.current=0; setSelectedClipId(null); setSelectedTrackId(null);
    setTracks(loaded); snapshot("Load session");
  };

  const deleteSessionById = async (id) => {
    await idbDel(id);
    const index=getSessionIndex().filter(s=>s.id!==id);
    localStorage.setItem("wavr-sessions",JSON.stringify(index));
    setSessionsList(index);
  };

  const promptSave = () => {
    const name=prompt("Session name:","My Session "+new Date().toLocaleDateString());
    if (name===null) return;
    saveSession(name.trim()||"Untitled");
  };

  const newSession = () => {
    if (!confirm("Start a new session? Unsaved changes will be lost.")) return;
    stopPlayback();
    setTracks([]); setBpm(120); setTotalBeats(96);
    playOffsetRef.current=0; setSelectedClipId(null); setSelectedTrackId(null); setEqTrackId(null);
    historyRef.current=[]; histIdxRef.current=-1; setHistoryItems([]); setHistoryIdx(-1);
    snapshot("New session");
  };

  // ── Autosave
  useEffect(() => {
    const iv=setInterval(()=>{
      if (tracksRef.current.length&&tracksRef.current.some(t=>t.clips.length)){
        const id="session___autosave__";
        const data={id,name:"__autosave__",savedAt:Date.now(),bpm:bpmRef.current,totalBeats:totalBeatsRef.current,tracks:tracksRef.current.map(t=>({...t,gainNode:null,vuAnalyser:null,eqNodes:null,clips:t.clips.map(c=>({...c,bufferRaw:c.buffer?bufferToRaw(c.buffer):null,buffer:undefined}))}))};
        idbPut(data).catch(()=>{});
      }
    }, 60000);
    return ()=>clearInterval(iv);
  }, []);

  // ── Sessions modal population
  useEffect(()=>{ setSessionsList(getSessionIndex()); },[]);

  // ── Keyboard
  useEffect(() => {
    const onKey = e => {
      if (e.target.tagName==="INPUT"||e.target.contentEditable==="true") return;
      if (e.code==="Space"){e.preventDefault(); isPlayingRef.current?stopPlayback():startPlayback();}
      else if (e.code==="Home"){e.preventDefault();rewind();}
      else if ((e.ctrlKey||e.metaKey)&&e.code==="KeyZ"){e.preventDefault();e.shiftKey?redo():undo();}
      else if ((e.ctrlKey||e.metaKey)&&(e.code==="KeyY")){e.preventDefault();redo();}
      else if ((e.ctrlKey||e.metaKey)&&e.code==="KeyS"){e.preventDefault();promptSave();}
      else if ((e.code==="Delete"||e.code==="Backspace")&&selectedClipId){
        e.preventDefault(); snapshot("Delete clip (key)");
        setTracks(prev=>prev.map(t=>({...t,clips:t.clips.filter(c=>c.id!==selectedClipId)})));
        setSelectedClipId(null);
      }
    };
    document.addEventListener("keydown",onKey);
    return ()=>document.removeEventListener("keydown",onKey);
  }, [selectedClipId, startPlayback, stopPlayback, rewind, undo, redo, snapshot]);

  // ── Click outside dismissals
  useEffect(()=>{
    const onClick = e => {
      if (!e.target.closest(".ctx-menu")) setShowCtxMenu(false);
      if (!e.target.closest(".history-panel") && !e.target.closest(".history-btn")) setShowHistory(false);
    };
    document.addEventListener("click",onClick);
    return ()=>document.removeEventListener("click",onClick);
  },[]);

  // ── Demo bootstrap
  useEffect(()=>{
    const ctx=getCtx();
    function mkBuf(freq,type,beats,vol,decay=.9){
      const dur=b2s(beats,120);
      const off=new OfflineAudioContext(1,Math.ceil(ctx.sampleRate*dur),ctx.sampleRate);
      const osc=off.createOscillator(); osc.frequency.value=freq; osc.type=type;
      const g=off.createGain(); g.gain.setValueAtTime(vol,0); g.gain.exponentialRampToValueAtTime(.001,dur*decay);
      osc.connect(g); g.connect(off.destination); osc.start(0); osc.stop(dur);
      return off.startRendering();
    }
    const T=[
      {name:"Bass Synth",color:COLORS[0]},
      {name:"Lead",     color:COLORS[1]},
      {name:"Pads",     color:COLORS[2]},
      {name:"Drums",    color:COLORS[3]},
    ];
    Promise.all([
      mkBuf(82,"sawtooth",4,.5), mkBuf(82,"sawtooth",4,.5),
      mkBuf(330,"triangle",4,.35), mkBuf(392,"triangle",4,.35),
      mkBuf(196,"sine",4,.25), mkBuf(523,"sine",4,.2),
      mkBuf(55,"square",1,.6,.3), mkBuf(110,"square",1,.4,.3),
    ]).then(([b1,b2,b3,b4,b5,b6,b7,b8])=>{
      const t1={id:uid(),...T[0],clips:[{id:"d1",name:"Bass 1",start:0,duration:4,buffer:b1},{id:"d2",name:"Bass 2",start:8,duration:4,buffer:b2}],muted:false,solo:false,armed:false,volume:.8,gainNode:null,vuAnalyser:null,eqNodes:null,eq:defaultEQ()};
      const t2={id:uid(),...T[1],clips:[{id:"d3",name:"Lead 1",start:4,duration:4,buffer:b3},{id:"d4",name:"Lead 2",start:12,duration:4,buffer:b4}],muted:false,solo:false,armed:false,volume:.8,gainNode:null,vuAnalyser:null,eqNodes:null,eq:defaultEQ()};
      const t3={id:uid(),...T[2],clips:[{id:"d5",name:"Pad 1",start:0,duration:4,buffer:b5},{id:"d6",name:"Pad 2",start:16,duration:4,buffer:b6}],muted:false,solo:false,armed:false,volume:.8,gainNode:null,vuAnalyser:null,eqNodes:null,eq:defaultEQ()};
      const t4={id:uid(),...T[3],clips:[{id:"d7",name:"Kick 1",start:0,duration:1,buffer:b7},{id:"d8",name:"Kick 2",start:2,duration:1,buffer:b8},{id:"d9",name:"Kick 3",start:4,duration:1,buffer:b7}],muted:false,solo:false,armed:false,volume:.8,gainNode:null,vuAnalyser:null,eqNodes:null,eq:defaultEQ()};
      const init=[t1,t2,t3,t4];
      tracksRef.current=init; setTracks(init); snapshot("Initial session");
    }).catch(()=>snapshot("Initial session"));
  },[]);

  // ── Helpers for render
  const hasSolo = tracks.some(t=>t.solo);
  const eqTrack = tracks.find(t=>t.id===eqTrackId)||tracks[0]||null;

  // ── Render ───────────────────────────────────────────────────
  return (
    <div className="wavr-root" style={{ position:"relative" }}>
      <style>{STYLES}</style>

      {/* TOPBAR */}
      <div className="topbar">
        <span className="logo">WAVR<sup>PRO</sup></span>
        <button className="tbtn" onClick={rewind} title="Rewind (Home)">⏮</button>
        <button className={`tbtn${isPlaying?" active":""}`} onClick={()=>isPlaying?stopPlayback():startPlayback()} title="Play/Pause (Space)">▶</button>
        <button className="tbtn" onClick={stopPlayback} title="Stop">■</button>
        <button className={`tbtn${isRecording?" rec-active":""}`} onClick={()=>{ if(isPlaying){if(mediaRecRef.current)mediaRecRef.current.stop();stopPlayback();}else startRecording(); }} title="Record">●</button>
        <div className="bpm-wrap">
          <label>BPM</label>
          <input className="bpm-input" type="number" min="20" max="300" value={bpm} onChange={e=>{ const v=clamp(parseInt(e.target.value)||120,20,300); setBpm(v); bpmRef.current=v; }} />
        </div>
        <div className="timecode">{timecode}</div>
        <div className="sep"/>
        <button className="tlbl" onClick={undo} title="Undo (Ctrl+Z)">↩ Undo</button>
        <button className="tlbl" onClick={redo} title="Redo (Ctrl+Y)">↪ Redo</button>
        <button className="tlbl history-btn" onClick={e=>{e.stopPropagation();setShowHistory(h=>!h);}}>☰ History</button>
        <div className="sep"/>
        <button className="tlbl" onClick={newSession}>⊕ New</button>
        <button className="tlbl tl" onClick={promptSave}>◈ Save</button>
        <button className="tlbl" onClick={()=>{ setSessionsList(getSessionIndex()); setModal({type:"sessions"}); }}>↺ Sessions</button>
        <div className="sep"/>
        <button className="tlbl tl" onClick={()=>document.getElementById("wavr-upload").click()}>↑ Import</button>
        <input id="wavr-upload" type="file" accept="audio/*" multiple style={{display:"none"}} onChange={e=>{loadFilesAsNewTracks(e.target.files);e.target.value="";}}/>
        <button className="tlbl am" onClick={exportMix}>↓ Export WAV</button>
        <div className="sep"/>
        <button className="add-track-btn" onClick={()=>{addTrack();snapshot("Add track");}}>+ Track</button>
      </div>

      {/* NOTICES */}
      <div>
        <div className="notice limit-bar">
          <span className="ni">⚠</span>
          <div className="nt"><strong>Browser DAW limits:</strong> Export is offline render only · No VST/AU · No MIDI · Audio pauses in background tabs · Data lost on refresh</div>
        </div>
        {ctxNotice && <div className="notice ctx-notice"><span className="ni">▶</span><span className="nt">Click Play to activate audio context (browser autoplay policy)</span></div>}
        {exportState.show && (
          <div className="notice export-bar">
            <span className="nt">{exportState.status}</span>
            <progress value={exportState.pct} max="100" />
            <span className="ep">{exportState.pct}%</span>
          </div>
        )}
      </div>

      {/* BODY */}
      <div className="daw-body">
        {/* Track Headers */}
        <div className="track-headers">
          <div className="th-scroll" ref={thScrollRef}>
            {tracks.map(t=>(
              <div key={t.id} className={`track-header${t.id===selectedTrackId?" selected":""}`} onClick={()=>{setSelectedTrackId(t.id);setEqTrackId(t.id);}}>
                <div className="th-top">
                  <div className="track-dot" style={{background:t.color,boxShadow:`0 0 5px ${t.color}66`}}/>
                  <input className="track-name-input" value={t.name} onChange={e=>setTracks(prev=>prev.map(x=>x.id===t.id?{...x,name:e.target.value}:x))} onBlur={()=>snapshot("Rename track")} onClick={e=>e.stopPropagation()}/>
                  <button className="ic-btn del-ic" onClick={e=>{e.stopPropagation();setModal({type:"delete-track",track:t});}} title="Delete track">✕</button>
                </div>
                <div className="th-btns">
                  {[["arm","R",t.armed?"on-r":""],["mute","M",t.muted?"on-m":""],["solo","S",t.solo?"on-s":""],["eq","EQ",t.id===eqTrackId?"on-e":""]].map(([act,lbl,cls])=>(
                    <button key={act} className={`ic-btn ${cls}`} onClick={e=>{e.stopPropagation();
                      if(act==="arm"){const updated=tracks.map(x=>x.id===t.id?{...x,armed:!x.armed}:x);setTracks(updated);if(!t.armed)reqMic();snapshot("Arm track");}
                      else if(act==="mute"){setTracks(prev=>prev.map(x=>x.id===t.id?{...x,muted:!x.muted}:x));snapshot("Mute track");}
                      else if(act==="solo"){setTracks(prev=>prev.map(x=>x.id===t.id?{...x,solo:!x.solo}:x));snapshot("Solo track");}
                      else if(act==="eq"){setEqTrackId(t.id);}
                    }}>{lbl}</button>
                  ))}
                </div>
                <div className="vol-row">
                  <span className="vol-label">{Math.round(t.volume*100)}</span>
                  <input type="range" className="vol-slider" min="0" max="1" step="0.01" value={t.volume} onClick={e=>e.stopPropagation()}
                    onChange={e=>{const v=parseFloat(e.target.value); setTracks(prev=>prev.map(x=>x.id===t.id?{...x,volume:v}:x)); if(t.gainNode)t.gainNode.gain.value=v;}}/>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Timeline */}
        <div className="timeline-wrap">
          <div className="ruler-wrap">
            <canvas className="ruler-canvas" ref={rulerRef}/>
          </div>
          <div className="tracks-scroll" ref={scrollRef}
            onDragOver={e=>e.preventDefault()}
            onDragLeave={()=>setShowDrop(false)}
            onDrop={e=>{e.preventDefault();setShowDrop(false);if(!e.target.closest(".track-lane"))loadFilesAsNewTracks(e.dataTransfer.files);}}
          >
            <div className="tracks-container" ref={el=>{if(el){el.style.width=totalW(totalBeats)+"px";el.style.minHeight=(tracks.length*72+60)+"px";}}}>
              <div className="playhead" ref={playheadRef}/>
              {tracks.map(t=>(
                <div key={t.id} className={`track-lane${(t.muted||(hasSolo&&!t.solo))?" dimmed":""}`}
                  onDragOver={e=>{e.preventDefault();e.currentTarget.classList.add("drag-over");}}
                  onDragLeave={e=>e.currentTarget.classList.remove("drag-over")}
                  onDrop={e=>{e.preventDefault();e.currentTarget.classList.remove("drag-over");const files=Array.from(e.dataTransfer.files).filter(f=>f.type.startsWith("audio/"));if(!files.length)return;const rect=e.currentTarget.getBoundingClientRect();const x=e.clientX-rect.left+(scrollRef.current?.scrollLeft||0);loadFilesIntoTrack(t,files,x2b(x));}}
                  onClick={e=>{if(e.target.classList.contains("track-lane")){const rect=e.currentTarget.getBoundingClientRect();const x=e.clientX-rect.left+(scrollRef.current?.scrollLeft||0);setSelectedTrackId(t.id);setEqTrackId(t.id);dropSynth(t,x2b(x));}}}
                >
                  {t.clips.map(clip=>{
                    const drag=makeDragHandler(t,clip);
                    const resize=makeResizeHandler(t,clip);
                    return (
                      <Clip key={clip.id} clip={clip} track={t} bpm={bpm}
                        selected={selectedClipId===clip.id}
                        onMouseDown={drag.onMouseDown} onTouchStart={drag.onTouchStart}
                        onResizeMouseDown={resize.onMouseDown} onResizeTouchStart={resize.onTouchStart}
                        onClick={e=>{e.stopPropagation();setSelectedClipId(clip.id);setSelectedTrackId(t.id);setEqTrackId(t.id);}}
                        onContextMenu={e=>{e.preventDefault();setCtxClip(clip);setCtxTrack(t);setCtxMenuPos({x:clamp(e.clientX,4,window.innerWidth-160),y:clamp(e.clientY,4,window.innerHeight-220)});setShowCtxMenu(true);}}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
            {showDrop&&<div className="drop-overlay"><div className="drop-title">Drop Audio Files</div><div className="drop-sub">WAV · MP3 · OGG · FLAC · M4A</div></div>}
          </div>
        </div>
      </div>

      {/* BOTTOM PANEL */}
      <div className="bottom-panel">
        {/* Mixer */}
        <div className="mixer-section">
          {tracks.map(t=>(
            <div key={t.id} className={`mixer-strip${t.id===selectedTrackId?" active":""}`} onClick={()=>{setSelectedTrackId(t.id);setEqTrackId(t.id);}}>
              <div className="strip-name" title={t.name}>{t.name}</div>
              <div style={{display:"flex",gap:4,alignItems:"flex-end"}}>
                <div className="vu-bar"><div className="vu-fill" ref={el=>vuFillsRef.current[t.id]=el} style={{background:t.color}}/></div>
                <input type="range" className="fader" min="0" max="1" step="0.01" value={t.volume}
                  onChange={e=>{const v=parseFloat(e.target.value);setTracks(prev=>prev.map(x=>x.id===t.id?{...x,volume:v}:x));if(t.gainNode)t.gainNode.gain.value=v;}}/>
              </div>
              <div className="strip-vol">{Math.round(t.volume*100)}</div>
            </div>
          ))}
        </div>

        {/* Visualizer */}
        <div className="visualizer">
          <div className="vis-tabs">
            {["waveform","spectrum","spectrogram","oscilloscope","lissajous"].map(m=>(
              <div key={m} className={`vis-tab${activeVisMode===m?" active":""}`} onClick={()=>{setActiveVisMode(m);spectroRef.current=[];}}>{m==="oscilloscope"?"Scope":m.charAt(0).toUpperCase()+m.slice(1)}</div>
            ))}
          </div>
          <div className="vis-canvas-wrap">
            <canvas ref={visCanvasRef}/>
          </div>
        </div>

        {/* EQ */}
        <EQPanel track={eqTrack} eqTrackId={eqTrackId}
          onEQChange={(bandIdx, key, value) => {
            if (!eqTrack) return;
            handleEQChange(eqTrack.id, bandIdx, key, value);
            snapshot("EQ adjust");
          }}
        />
      </div>

      {/* CLIP CONTEXT MENU */}
      {showCtxMenu && (
        <div className="ctx-menu" style={{left:ctxMenuPos.x, top:ctxMenuPos.y}}>
          <div className="cm-item" onClick={cmRename}>✎ Rename</div>
          <div className="cm-item" onClick={cmDuplicate}>⎘ Duplicate</div>
          <div className="cm-item" onClick={cmReplace}>↺ Replace with file…</div>
          <div className="cm-sep"/>
          <div className="cm-item" onClick={cmColor}>◉ Change colour</div>
          <div className="cm-item" onClick={cmGain}>◈ Adjust gain…</div>
          <div className="cm-sep"/>
          <div className="cm-item danger" onClick={cmDelete}>✕ Delete clip</div>
        </div>
      )}
      <input id="wavr-replace-input" type="file" accept="audio/*" style={{display:"none"}} onChange={e=>{
        const file=e.target.files[0]; if(!file||!ctxClip||!ctxTrack) return;
        const reader=new FileReader();
        reader.onload=ev=>{ getCtx().decodeAudioData(ev.target.result.slice(0)).then(buf=>{
          snapshot("Replace clip");
          setTracks(prev=>prev.map(t=>t.id===ctxTrack.id?{...t,clips:t.clips.map(c=>c.id===ctxClip.id?{...c,buffer:buf,duration:s2b(buf.duration,bpmRef.current),name:file.name.replace(/\.[^/.]+$/,"")}:c)}:t));
        }).catch(()=>alert("Could not decode replacement file.")); };
        reader.readAsArrayBuffer(file); e.target.value="";
      }}/>

      {/* HISTORY PANEL */}
      <div className={`history-panel${showHistory?" open":""}`}>
        <h4>☰ Session History</h4>
        <div className="hist-list">
          {[...historyItems].reverse().map((h,ri)=>{
            const realIdx=historyItems.length-1-ri;
            const t=new Date(h.time); const ts=t.getHours()+":"+(t.getMinutes()+"").padStart(2,"0")+":"+(t.getSeconds()+"").padStart(2,"0");
            return <div key={realIdx} className={`hist-item${realIdx===historyIdx?" current":""}`} onClick={()=>restoreSnapshot(realIdx)}><span className="hi-action">{h.action}</span><span className="hi-time">{ts}</span></div>;
          })}
        </div>
      </div>

      {/* TOAST */}
      <div className={`toast${toast.show?" show":""}`}>
        <span>{toast.msg}</span>
        <button onClick={toast.showRedo?redo:undo}>{toast.showRedo?"Redo":"Undo"}</button>
      </div>

      {/* MODALS */}
      {modal?.type==="rename" && (
        <div className="modal-backdrop" onClick={e=>{if(e.target.classList.contains("modal-backdrop"))setModal(null);}}>
          <div className="modal">
            <h3>Rename</h3>
            <RenameModalInner initial={modal.value} onOk={v=>{modal.onOk(v);setModal(null);}} onCancel={()=>setModal(null)}/>
          </div>
        </div>
      )}
      {modal?.type==="gain" && (
        <div className="modal-backdrop" onClick={e=>{if(e.target.classList.contains("modal-backdrop"))setModal(null);}}>
          <div className="modal">
            <h3>Clip Gain</h3>
            <p>Adjust the gain of this clip (dB). Re-renders the audio buffer.</p>
            <GainModalInner onOk={v=>{modal.onOk(v);setModal(null);}} onCancel={()=>setModal(null)}/>
          </div>
        </div>
      )}
      {modal?.type==="delete-track" && (
        <div className="modal-backdrop" onClick={e=>{if(e.target.classList.contains("modal-backdrop"))setModal(null);}}>
          <div className="modal">
            <h3>Delete Track?</h3>
            <p>Delete "{modal.track?.name}" and all its clips? This cannot be undone.</p>
            <div className="modal-row">
              <button className="modal-btn danger" onClick={()=>{snapshot("Delete track");setTracks(prev=>prev.filter(t=>t.id!==modal.track.id));setModal(null);}}>Delete</button>
              <button className="modal-btn" onClick={()=>setModal(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {modal?.type==="sessions" && (
        <div className="modal-backdrop" onClick={e=>{if(e.target.classList.contains("modal-backdrop"))setModal(null);}}>
          <div className="modal" style={{minWidth:380}}>
            <h3>Saved Sessions</h3>
            <div className="sessions-list">
              {sessionsList.length===0 && <div style={{color:"var(--mt)",fontSize:10,padding:10}}>No saved sessions yet.</div>}
              {sessionsList.map(s=>{
                const dt=new Date(s.savedAt);
                const ds=dt.toLocaleDateString()+" "+dt.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
                return (
                  <div key={s.id} className="session-item">
                    <div style={{flex:1}}><div className="si-name">{s.name}</div><div className="si-date">{ds}</div></div>
                    <button className="si-load" onClick={()=>{loadSessionById(s.id);setModal(null);}}>Load</button>
                    <button className="si-del" onClick={async()=>{await deleteSessionById(s.id);}}>✕</button>
                  </div>
                );
              })}
            </div>
            <div className="modal-row"><button className="modal-btn" onClick={()=>setModal(null)}>Close</button></div>
          </div>
        </div>
      )}

      {/* Drag drop overlay on the outer wrapper */}
      <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:300}} onDragOver={e=>{e.preventDefault();setShowDrop(true);}} onDragLeave={e=>{if(!e.relatedTarget)setShowDrop(false);}} onDrop={e=>{e.preventDefault();setShowDrop(false);loadFilesAsNewTracks(e.dataTransfer.files);}}>
        {showDrop&&<div className="drop-overlay" style={{pointerEvents:"none"}}><div className="drop-title">Drop Audio Files</div><div className="drop-sub">WAV · MP3 · OGG · FLAC · M4A · AAC</div></div>}
      </div>
    </div>
  );
}

// ─── Small modal sub-components ──────────────────────────────
function RenameModalInner({ initial, onOk, onCancel }) {
  const [val, setVal] = useState(initial||"");
  return <>
    <input className="modal-input" value={val} onChange={e=>setVal(e.target.value)} autoFocus onKeyDown={e=>{if(e.key==="Enter")onOk(val);if(e.key==="Escape")onCancel();}}/>
    <div className="modal-row">
      <button className="modal-btn primary" onClick={()=>onOk(val)}>OK</button>
      <button className="modal-btn" onClick={onCancel}>Cancel</button>
    </div>
  </>;
}

function GainModalInner({ onOk, onCancel }) {
  const [db, setDb] = useState(0);
  return <>
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
      <input type="range" min="-24" max="24" step="0.5" value={db} onChange={e=>setDb(parseFloat(e.target.value))} style={{flex:1,accentColor:"var(--ac)"}}/>
      <span style={{color:"var(--tl)",minWidth:40,textAlign:"right",fontSize:12}}>{db>=0?"+":""}{db} dB</span>
    </div>
    <div className="modal-row">
      <button className="modal-btn primary" onClick={()=>onOk(db)}>Apply</button>
      <button className="modal-btn" onClick={onCancel}>Cancel</button>
    </div>
  </>;
}
