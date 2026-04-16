/**
 * DrumMachine.js — VST-style drum sequencer plugin
 * Pure vanilla JS class. Zero dependencies. Zero framework lock-in.
 *
 * USAGE (plain HTML):
 *   const dm = new DrumMachine({ audioContext: myCtx, bpm: 120 });
 *   dm.mount(document.getElementById('container'));
 *
 * USAGE (React — inject via useEffect):
 *   useEffect(() => {
 *     const dm = new DrumMachine({ audioContext: getCtx(), bpm });
 *     dm.mount(containerRef.current);
 *     return () => dm.destroy();
 *   }, []);
 *
 * INTEGRATION with WavrPro:
 *   dm.onRender = (audioBuffer, bpm) => {
 *     // audioBuffer is the rendered 1-bar loop at current bpm
 *     // drop it into a track clip however you like
 *   };
 *
 * API:
 *   dm.mount(el)        — render UI into el, start internal clock
 *   dm.destroy()        — stop, remove UI, release audio nodes
 *   dm.setBpm(120)      — sync to host transport BPM
 *   dm.start()          — begin internal sequencer loop
 *   dm.stop()           — halt sequencer
 *   dm.getPattern()     — returns serialisable pattern state
 *   dm.loadPattern(obj) — restore previously saved pattern state
 *   dm.renderToBuffer() — returns Promise<AudioBuffer> (1 bar)
 *   dm.onRender         — callback(AudioBuffer, bpm) called after renderToBuffer
 *   dm.onPatternChange  — callback(pattern) called on any step/param change
 */

class DrumMachine extends WavrPlugin {
  // ── Plugin metadata ──────────────────────────────────────────
  static pluginId          = "drum-machine";
  static pluginName        = "Drum Machine";
  static pluginColor       = "#ff6b35";
  static pluginMode        = "modal";
  static pluginCategory    = "instrument";
  static pluginDescription = "16/32-step drum sequencer with 8 synthesized instruments, swing, velocity, and presets.";
  static pluginVersion     = "2.0.0";

  // ── Default instruments ─────────────────────────────────────
  static INSTRUMENTS = [
    {
      id: "kick",
      label: "Kick",
      color: "#ff6b35",
      synth: (ctx, when, vel) => {
        const g = ctx.createGain();
        g.connect(ctx.destination);
        // pitch-swept body
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.setValueAtTime(180, when);
        o.frequency.exponentialRampToValueAtTime(38, when + 0.12);
        g.gain.setValueAtTime(vel * 1.1, when);
        g.gain.exponentialRampToValueAtTime(0.001, when + 0.38);
        o.connect(g); o.start(when); o.stop(when + 0.4);
        // click transient
        const c = ctx.createOscillator(), cg = ctx.createGain();
        c.type = "square"; c.frequency.value = 1400;
        cg.gain.setValueAtTime(vel * 0.35, when);
        cg.gain.exponentialRampToValueAtTime(0.001, when + 0.012);
        c.connect(cg); cg.connect(ctx.destination); c.start(when); c.stop(when + 0.015);
      },
    },
    {
      id: "snare",
      label: "Snare",
      color: "#ff9a6c",
      synth: (ctx, when, vel) => {
        const sr = ctx.sampleRate;
        // noise
        const len = Math.ceil(0.22 * sr);
        const nb = ctx.createBuffer(1, len, sr);
        const nd = nb.getChannelData(0);
        for (let i = 0; i < len; i++) nd[i] = Math.random() * 2 - 1;
        const ns = ctx.createBufferSource(); ns.buffer = nb;
        const filt = ctx.createBiquadFilter(); filt.type = "bandpass"; filt.frequency.value = 3800; filt.Q.value = 0.9;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(vel * 0.65, when); ng.gain.exponentialRampToValueAtTime(0.001, when + 0.2);
        ns.connect(filt); filt.connect(ng); ng.connect(ctx.destination); ns.start(when); ns.stop(when + 0.25);
        // body tone
        const o = ctx.createOscillator(), og = ctx.createGain();
        o.type = "triangle"; o.frequency.value = 190;
        og.gain.setValueAtTime(vel * 0.3, when); og.gain.exponentialRampToValueAtTime(0.001, when + 0.08);
        o.connect(og); og.connect(ctx.destination); o.start(when); o.stop(when + 0.1);
      },
    },
    {
      id: "clap",
      label: "Clap",
      color: "#ffd166",
      synth: (ctx, when, vel) => {
        const sr = ctx.sampleRate;
        [0, 0.008, 0.016].forEach(offset => {
          const len = Math.ceil(0.12 * sr);
          const nb = ctx.createBuffer(1, len, sr);
          const nd = nb.getChannelData(0);
          for (let i = 0; i < len; i++) nd[i] = Math.random() * 2 - 1;
          const ns = ctx.createBufferSource(); ns.buffer = nb;
          const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1100; f.Q.value = 1.2;
          const g = ctx.createGain();
          g.gain.setValueAtTime(vel * (offset === 0 ? 0.5 : 0.35), when + offset);
          g.gain.exponentialRampToValueAtTime(0.001, when + offset + 0.1);
          ns.connect(f); f.connect(g); g.connect(ctx.destination); ns.start(when + offset); ns.stop(when + offset + 0.14);
        });
      },
    },
    {
      id: "hhc",
      label: "HH Closed",
      color: "#52d9a0",
      synth: (ctx, when, vel) => {
        const sr = ctx.sampleRate;
        const len = Math.ceil(0.05 * sr);
        const nb = ctx.createBuffer(1, len, sr);
        const nd = nb.getChannelData(0);
        for (let i = 0; i < len; i++) nd[i] = Math.random() * 2 - 1;
        const ns = ctx.createBufferSource(); ns.buffer = nb;
        const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 8000;
        const g = ctx.createGain();
        g.gain.setValueAtTime(vel * 0.28, when); g.gain.exponentialRampToValueAtTime(0.001, when + 0.045);
        ns.connect(f); f.connect(g); g.connect(ctx.destination); ns.start(when); ns.stop(when + 0.06);
      },
    },
    {
      id: "hho",
      label: "HH Open",
      color: "#4fc3f7",
      synth: (ctx, when, vel) => {
        const sr = ctx.sampleRate;
        const len = Math.ceil(0.35 * sr);
        const nb = ctx.createBuffer(1, len, sr);
        const nd = nb.getChannelData(0);
        for (let i = 0; i < len; i++) nd[i] = Math.random() * 2 - 1;
        const ns = ctx.createBufferSource(); ns.buffer = nb;
        const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 6000;
        const f2 = ctx.createBiquadFilter(); f2.type = "peaking"; f2.frequency.value = 10000; f2.gain.value = 6;
        const g = ctx.createGain();
        g.gain.setValueAtTime(vel * 0.22, when); g.gain.exponentialRampToValueAtTime(0.001, when + 0.32);
        ns.connect(f); f.connect(f2); f2.connect(g); g.connect(ctx.destination); ns.start(when); ns.stop(when + 0.36);
      },
    },
    {
      id: "tom_hi",
      label: "Tom Hi",
      color: "#a29bfe",
      synth: (ctx, when, vel) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "sine";
        o.frequency.setValueAtTime(280, when);
        o.frequency.exponentialRampToValueAtTime(120, when + 0.18);
        g.gain.setValueAtTime(vel * 0.75, when); g.gain.exponentialRampToValueAtTime(0.001, when + 0.22);
        o.connect(g); g.connect(ctx.destination); o.start(when); o.stop(when + 0.25);
      },
    },
    {
      id: "tom_mid",
      label: "Tom Mid",
      color: "#fd79a8",
      synth: (ctx, when, vel) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "sine";
        o.frequency.setValueAtTime(180, when);
        o.frequency.exponentialRampToValueAtTime(75, when + 0.22);
        g.gain.setValueAtTime(vel * 0.78, when); g.gain.exponentialRampToValueAtTime(0.001, when + 0.28);
        o.connect(g); g.connect(ctx.destination); o.start(when); o.stop(when + 0.32);
      },
    },
    {
      id: "ride",
      label: "Ride",
      color: "#ffeaa7",
      synth: (ctx, when, vel) => {
        const sr = ctx.sampleRate;
        const len = Math.ceil(0.5 * sr);
        const nb = ctx.createBuffer(1, len, sr);
        const nd = nb.getChannelData(0);
        for (let i = 0; i < len; i++) nd[i] = Math.random() * 2 - 1;
        const ns = ctx.createBufferSource(); ns.buffer = nb;
        const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 5500; f.Q.value = 0.5;
        const g = ctx.createGain();
        g.gain.setValueAtTime(vel * 0.18, when); g.gain.exponentialRampToValueAtTime(0.001, when + 0.45);
        ns.connect(f); f.connect(g); g.connect(ctx.destination); ns.start(when); ns.stop(when + 0.55);
      },
    },
  ];

  constructor(hostAPIOrLegacy, optionsOrUndefined = {}) {
    // Support plugin-framework call: new DrumMachine(hostAPI, options)
    // AND legacy standalone call:    new DrumMachine({ audioContext, bpm, steps })
    const isLegacy = !hostAPIOrLegacy || !hostAPIOrLegacy.onRender;
    const legacyCtx  = isLegacy ? (hostAPIOrLegacy?.audioContext || new (window.AudioContext || window.webkitAudioContext)()) : null;
    const resolvedHostAPI = isLegacy ? {
      audioContext:  legacyCtx,
      bpm:           hostAPIOrLegacy?.bpm || 120,
      onRender:      () => {},
      onStateChange: () => {},
      onNotify:      (msg) => console.log("[DrumMachine]", msg),
      addTrack:      () => ({ id: null, clips: [] }),
      getPlayhead:   () => ({ beat: 0, isPlaying: false, contextTime: 0 }),
      getTracks:     () => [],
    } : hostAPIOrLegacy;
    const options = isLegacy ? (hostAPIOrLegacy || {}) : (optionsOrUndefined || {});
    super(resolvedHostAPI, options);
    const bpm      = resolvedHostAPI.bpm || 120;
    const steps    = options.steps    || (isLegacy && hostAPIOrLegacy?.steps)    || 16;
    const container= options.container|| (isLegacy && hostAPIOrLegacy?.container)|| null;
    this._bpm    = bpm;
    this._steps  = steps;       // 16 or 32
    this._swing  = 0;           // 0–100
    this._masterVol = 0.85;
    this._running = false;
    this._currentStep = 0;
    this._nextStepTime = 0;
    this._timerID = null;
    this._scheduleAheadTime = 0.1;
    this._lookahead = 25; // ms
    this._el = null;

    // Master gain
    this._masterGain = this.ctx.createGain();
    this._masterGain.gain.value = this._masterVol;
    this._masterGain.connect(this.ctx.destination);

    // Per-instrument gains routed through master
    this._instrGains = {};
    DrumMachine.INSTRUMENTS.forEach(inst => {
      const g = this.ctx.createGain();
      g.gain.value = 1;
      g.connect(this._masterGain);
      this._instrGains[inst.id] = g;
    });

    // Pattern: [instrId][step] = { active, velocity (0–1) }
    this._pattern = this._defaultPattern();

    // Callbacks
    this.onRender        = null; // (AudioBuffer, bpm) => void
    this.onPatternChange = null; // (pattern) => void
    this.onStepTick      = null; // (step) => void — for host transport sync

    if (container) this.mount(container);
  }

  // ── Public API ─────────────────────────────────────────────

  mount(el) {
    this._el = el;
    this._injectStyles();
    el.innerHTML = this._buildHTML();
    this._bindEvents();
    this._updateStepHighlight(-1);
  }

  destroy() {
    this.stop();
    this._masterGain.disconnect();
    super.destroy();  // clears this._el.innerHTML
  }

  setBpm(bpm) {
    this._bpm = Math.max(20, Math.min(300, bpm));
    const inp = this._el?.querySelector(".dm-bpm-input");
    if (inp) inp.value = this._bpm;
  }

  start() {
    if (this._running) return;
    if (this.ctx.state === "suspended") this.ctx.resume();
    this._running = true;
    this._currentStep = 0;
    this._nextStepTime = this.ctx.currentTime + 0.05;
    this._scheduler();
    this._el?.querySelector(".dm-play-btn")?.classList.add("dm-active");
  }

  stop() {
    this._running = false;
    clearTimeout(this._timerID);
    this._updateStepHighlight(-1);
    this._el?.querySelector(".dm-play-btn")?.classList.remove("dm-active");
  }

  toggle() { this._running ? this.stop() : this.start(); }

  getPattern() {
    return {
      bpm:     this._bpm,
      steps:   this._steps,
      swing:   this._swing,
      master:  this._masterVol,
      pattern: JSON.parse(JSON.stringify(this._pattern)),
      instrVols: Object.fromEntries(
        DrumMachine.INSTRUMENTS.map(i => [i.id, this._instrGains[i.id].gain.value])
      ),
    };
  }

  loadPattern(state) {
    if (!state) return;
    if (state.bpm)     { this._bpm     = state.bpm;     this.setBpm(state.bpm); }
    if (state.steps)   { this._steps   = state.steps;   }
    if (state.swing !== undefined)  this._swing  = state.swing;
    if (state.master !== undefined) {
      this._masterVol = state.master;
      this._masterGain.gain.value = state.master;
    }
    if (state.pattern) this._pattern = state.pattern;
    if (state.instrVols) {
      Object.entries(state.instrVols).forEach(([id, vol]) => {
        if (this._instrGains[id]) this._instrGains[id].gain.value = vol;
      });
    }
    if (this._el) {
      this._el.innerHTML = this._buildHTML();
      this._bindEvents();
      this._updateStepHighlight(-1);
    }
  }

  async renderToBuffer() {
    const stepSec  = this._stepDuration();
    const totalSec = stepSec * this._steps;
    const sr       = this.ctx.sampleRate;
    const offCtx   = new OfflineAudioContext(2, Math.ceil(sr * totalSec), sr);

    // re-route through offline master gain
    const omg = offCtx.createGain();
    omg.gain.value = this._masterVol;
    omg.connect(offCtx.destination);

    DrumMachine.INSTRUMENTS.forEach(inst => {
      const ig = offCtx.createGain();
      ig.gain.value = this._instrGains[inst.id].gain.value;
      ig.connect(omg);

      const instrCtxPatch = {
        ...offCtx,
        destination: ig,
        sampleRate: offCtx.sampleRate,
        createGain:            ()    => offCtx.createGain(),
        createOscillator:      ()    => offCtx.createOscillator(),
        createBiquadFilter:    ()    => offCtx.createBiquadFilter(),
        createBuffer:          (c,l,r)=> offCtx.createBuffer(c,l,r),
        createBufferSource:    ()    => offCtx.createBufferSource(),
        currentTime:           0,
      };

      this._pattern[inst.id]?.forEach((cell, step) => {
        if (!cell.active) return;
        const t = this._swingTime(step, stepSec);
        // patch destination so synth routes to per-instrument gain
        const patchedCtx = new Proxy(offCtx, {
          get(target, key) {
            if (key === "destination") return ig;
            const v = target[key];
            return typeof v === "function" ? v.bind(target) : v;
          }
        });
        inst.synth(patchedCtx, t, cell.velocity);
      });
    });

    const buf = await offCtx.startRendering();
    this.emitBuffer(buf, this.constructor.pluginName);
    // Legacy callback
    if (typeof this.onRender === "function") this.onRender(buf, this._bpm);
    return buf;
  }

  // ── Internal: sequencer ──────────────────────────────────────

  _stepDuration() {
    // 1 step = 1 sixteenth note
    return (60 / this._bpm) / 4;
  }

  _swingTime(step, stepSec) {
    // Even steps: on-time. Odd steps: pushed forward by swing %
    if (this._swing === 0 || step % 2 === 0) return step * stepSec;
    const swingAmt = (this._swing / 100) * stepSec * 0.5;
    return step * stepSec + swingAmt;
  }

  _scheduler() {
    if (!this._running) return;
    const stepSec = this._stepDuration();
    while (this._nextStepTime < this.ctx.currentTime + this._scheduleAheadTime) {
      this._scheduleStep(this._currentStep, this._nextStepTime);
      this._advanceStep(stepSec);
    }
    this._timerID = setTimeout(() => this._scheduler(), this._lookahead);
  }

  _scheduleStep(step, when) {
    DrumMachine.INSTRUMENTS.forEach(inst => {
      const cell = this._pattern[inst.id]?.[step];
      if (!cell?.active) return;

      // patch ctx.destination → per-instrument gain
      const ig = this._instrGains[inst.id];
      const patchedCtx = new Proxy(this._ctx, {
        get(target, key) {
          if (key === "destination") return ig;
          const v = target[key];
          return typeof v === "function" ? v.bind(target) : v;
        }
      });
      inst.synth(patchedCtx, when, cell.velocity);
    });

    // visual tick — fire slightly before the beat so UI feels tight
    const delay = (when - this.ctx.currentTime) * 1000;
    setTimeout(() => {
      this._updateStepHighlight(step);
      if (typeof this.onStepTick === "function") this.onStepTick(step);
    }, Math.max(0, delay));
  }

  _advanceStep(stepSec) {
    this._nextStepTime += this._swingTime(this._currentStep + 1, stepSec) - this._swingTime(this._currentStep, stepSec);
    // Fallback: just use stepSec if swing math breaks
    if (!isFinite(this._nextStepTime)) this._nextStepTime += stepSec;
    this._currentStep = (this._currentStep + 1) % this._steps;
  }

  _updateStepHighlight(activeStep) {
    if (!this._el) return;
    this._el.querySelectorAll(".dm-step").forEach(btn => {
      const s = parseInt(btn.dataset.step, 10);
      btn.classList.toggle("dm-playing", s === activeStep);
    });
    // Also light up the step column indicator
    this._el.querySelectorAll(".dm-step-num").forEach(el => {
      el.classList.toggle("dm-step-num-active", parseInt(el.dataset.step, 10) === activeStep);
    });
  }

  // ── WavrPlugin interface overrides ──────────────────────────

  /** Returns pattern state — used by session save. */
  getState() { return this.getPattern(); }

  /** Restores pattern state — used by session load and re-open. */
  setState(state) { this.loadPattern(state); }

  /** Called by host when BPM changes in the DAW transport. */
  onBpmChange(bpm) {
    super.onBpmChange(bpm);
    this._bpm = bpm;
    const inp = this._el?.querySelector(".dm-bpm-input");
    if (inp) inp.value = bpm;
  }

  // ── Internal: default pattern ────────────────────────────────

  _defaultPattern() {
    const p = {};
    DrumMachine.INSTRUMENTS.forEach(inst => {
      p[inst.id] = Array.from({ length: 32 }, () => ({ active: false, velocity: 0.8 }));
    });
    // sensible default: basic 4/4 kick + snare + closed hh
    [0, 8].forEach(s => { p.kick[s].active    = true; });   // kick on 1 and 3
    [4, 12].forEach(s => { p.snare[s].active  = true; });   // snare on 2 and 4
    [0,2,4,6,8,10,12,14].forEach(s => { p.hhc[s].active = true; p.hhc[s].velocity = s%4===0?0.8:0.5; });
    return p;
  }

  // ── Internal: HTML builder ───────────────────────────────────

  _buildHTML() {
    const insts = DrumMachine.INSTRUMENTS;
    const steps = this._steps;

    const stepNums = Array.from({ length: steps }, (_, i) => {
      const isBar = i % 4 === 0;
      return `<div class="dm-step-num${isBar?" dm-bar-num":""}" data-step="${i}">${isBar ? Math.floor(i/4)+1 : "·"}</div>`;
    }).join("");

    const rows = insts.map(inst => {
      const cells = Array.from({ length: steps }, (_, i) => {
        const cell = this._pattern[inst.id][i];
        const groupClass = i % 4 === 0 ? " dm-group-start" : "";
        const activeClass = cell.active ? " dm-on" : "";
        const vel = cell.velocity;
        return `<button
          class="dm-step${activeClass}${groupClass}"
          data-instr="${inst.id}"
          data-step="${i}"
          style="${cell.active ? `--dm-vel:${vel};opacity:${0.45+vel*0.55};background:${inst.color}` : ""}"
          title="Step ${i+1} — right-click for velocity"
        ></button>`;
      }).join("");

      const vol = this._instrGains[inst.id].gain.value;
      return `
        <div class="dm-row" data-instr="${inst.id}">
          <div class="dm-row-label">
            <div class="dm-instr-dot" style="background:${inst.color}"></div>
            <span class="dm-instr-name">${inst.label}</span>
            <button class="dm-solo-btn" data-instr="${inst.id}" title="Solo">S</button>
            <button class="dm-mute-btn" data-instr="${inst.id}" title="Mute">M</button>
          </div>
          <div class="dm-cells">${cells}</div>
          <div class="dm-row-vol">
            <input type="range" class="dm-vol-slider" min="0" max="1" step="0.01"
              value="${vol}" data-instr="${inst.id}" title="Volume: ${Math.round(vol*100)}">
          </div>
        </div>`;
    }).join("");

    return `
      <div class="dm-root" data-steps="${steps}">
        <div class="dm-header">
          <span class="dm-logo">⬡ DRUM MACHINE</span>
          <div class="dm-controls">
            <button class="dm-btn dm-play-btn${this._running?" dm-active":""}">▶ Play</button>
            <button class="dm-btn dm-stop-btn">■ Stop</button>
            <div class="dm-sep"></div>
            <label class="dm-label">BPM</label>
            <input type="number" class="dm-bpm-input dm-num-input" min="20" max="300" value="${this._bpm}">
            <label class="dm-label">Steps</label>
            <select class="dm-steps-select dm-select">
              <option value="16"${steps===16?" selected":""}>16</option>
              <option value="32"${steps===32?" selected":""}>32</option>
            </select>
            <label class="dm-label">Swing</label>
            <input type="range" class="dm-swing-slider" min="0" max="75" step="1" value="${this._swing}" title="Swing">
            <span class="dm-swing-val">${this._swing}%</span>
            <div class="dm-sep"></div>
            <label class="dm-label">Vol</label>
            <input type="range" class="dm-master-vol" min="0" max="1" step="0.01" value="${this._masterVol}" title="Master volume">
          </div>
          <div class="dm-actions">
            <button class="dm-btn dm-clear-btn" title="Clear all steps">✕ Clear</button>
            <button class="dm-btn dm-random-btn" title="Random pattern">⟳ Rand</button>
            <button class="dm-btn dm-render-btn" title="Render 1 bar to audio">↓ Bounce</button>
          </div>
        </div>

        <div class="dm-grid-wrap">
          <div class="dm-step-nums-row">
            <div class="dm-row-label-spacer"></div>
            <div class="dm-step-nums">${stepNums}</div>
            <div class="dm-vol-spacer"></div>
          </div>
          ${rows}
        </div>

        <div class="dm-footer">
          <div class="dm-presets">
            <span class="dm-label">Presets:</span>
            <button class="dm-btn dm-preset-btn" data-preset="hiphop">Hip Hop</button>
            <button class="dm-btn dm-preset-btn" data-preset="house">House</button>
            <button class="dm-btn dm-preset-btn" data-preset="techno">Techno</button>
            <button class="dm-btn dm-preset-btn" data-preset="jungle">Jungle</button>
          </div>
          <div class="dm-status" id="dm-status"></div>
        </div>

        <div class="dm-vel-popup" id="dm-vel-popup" style="display:none">
          <label>Velocity</label>
          <input type="range" min="0.05" max="1" step="0.01" id="dm-vel-slider">
          <span id="dm-vel-val">80</span>
        </div>
      </div>`;
  }

  // ── Internal: event binding ──────────────────────────────────

  _bindEvents() {
    if (!this._el) return;
    const root = this._el.querySelector(".dm-root");

    // Play / stop
    root.querySelector(".dm-play-btn").addEventListener("click", () => this.toggle());
    root.querySelector(".dm-stop-btn").addEventListener("click", () => this.stop());

    // BPM
    root.querySelector(".dm-bpm-input").addEventListener("change", e => {
      this._bpm = Math.max(20, Math.min(300, parseInt(e.target.value) || 120));
      e.target.value = this._bpm;
    });

    // Steps
    root.querySelector(".dm-steps-select").addEventListener("change", e => {
      this._steps = parseInt(e.target.value);
      const wasRunning = this._running;
      if (wasRunning) this.stop();
      this._el.innerHTML = this._buildHTML();
      this._bindEvents();
      if (wasRunning) this.start();
    });

    // Swing
    const swingSlider = root.querySelector(".dm-swing-slider");
    swingSlider.addEventListener("input", e => {
      this._swing = parseInt(e.target.value);
      root.querySelector(".dm-swing-val").textContent = this._swing + "%";
    });

    // Master vol
    root.querySelector(".dm-master-vol").addEventListener("input", e => {
      this._masterVol = parseFloat(e.target.value);
      this._masterGain.gain.value = this._masterVol;
    });

    // Step buttons — click to toggle, right-click for velocity
    root.querySelectorAll(".dm-step").forEach(btn => {
      btn.addEventListener("click", e => this._toggleStep(e.currentTarget));
      btn.addEventListener("contextmenu", e => {
        e.preventDefault();
        this._showVelPopup(e.currentTarget, e.clientX, e.clientY);
      });
    });

    // Per-instrument volume
    root.querySelectorAll(".dm-vol-slider").forEach(sl => {
      sl.addEventListener("input", e => {
        const id = e.target.dataset.instr;
        const vol = parseFloat(e.target.value);
        if (this._instrGains[id]) this._instrGains[id].gain.value = vol;
        e.target.title = `Volume: ${Math.round(vol * 100)}`;
      });
    });

    // Solo
    root.querySelectorAll(".dm-solo-btn").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const id = btn.dataset.instr;
        const isSoloed = btn.classList.toggle("dm-soloed");
        // mute everything else when anything is soloed
        const anySolo = root.querySelectorAll(".dm-solo-btn.dm-soloed").length > 0;
        DrumMachine.INSTRUMENTS.forEach(inst => {
          const active = !anySolo || inst.id === id || root.querySelector(`.dm-solo-btn[data-instr="${inst.id}"]`)?.classList.contains("dm-soloed");
          if (this._instrGains[inst.id]) this._instrGains[inst.id].gain.value = active
            ? parseFloat(root.querySelector(`.dm-vol-slider[data-instr="${inst.id}"]`)?.value || 1)
            : 0;
        });
      });
    });

    // Mute
    root.querySelectorAll(".dm-mute-btn").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const id = btn.dataset.instr;
        const muted = btn.classList.toggle("dm-muted");
        if (this._instrGains[id]) {
          if (muted) {
            this._instrGains[id]._savedVol = this._instrGains[id].gain.value;
            this._instrGains[id].gain.value = 0;
          } else {
            this._instrGains[id].gain.value = this._instrGains[id]._savedVol ?? 1;
          }
        }
      });
    });

    // Clear
    root.querySelector(".dm-clear-btn").addEventListener("click", () => {
      DrumMachine.INSTRUMENTS.forEach(inst => {
        this._pattern[inst.id].forEach(c => { c.active = false; });
      });
      this._el.innerHTML = this._buildHTML();
      this._bindEvents();
      this._notify();
    });

    // Random
    root.querySelector(".dm-random-btn").addEventListener("click", () => {
      this._randomize();
    });

    // Bounce
    root.querySelector(".dm-render-btn").addEventListener("click", async () => {
      const btn = root.querySelector(".dm-render-btn");
      btn.textContent = "…";
      btn.disabled = true;
      try {
        await this.renderToBuffer();
        this.notify("Bounced!", "success");
      } catch (e) {
        this.notify("Render failed: " + e.message, "error");
      }
      btn.textContent = "↓ Bounce";
      btn.disabled = false;
    });

    // Presets
    root.querySelectorAll(".dm-preset-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        this._loadPreset(btn.dataset.preset);
      });
    });

    // Close vel popup on outside click
    document.addEventListener("click", this._closeVelPopup.bind(this), { once: true });
  }

  _toggleStep(btn) {
    const instr = btn.dataset.instr;
    const step  = parseInt(btn.dataset.step, 10);
    const cell  = this._pattern[instr][step];
    cell.active = !cell.active;
    const inst = DrumMachine.INSTRUMENTS.find(i => i.id === instr);
    btn.classList.toggle("dm-on", cell.active);
    if (cell.active) {
      btn.style.cssText = `--dm-vel:${cell.velocity};opacity:${0.45+cell.velocity*0.55};background:${inst.color}`;
    } else {
      btn.style.cssText = "";
    }
    // preview sound on activate
    if (cell.active && this.ctx.state !== "suspended") {
      const ig = this._instrGains[instr];
      const patchedCtx = new Proxy(this._ctx, {
        get(target, key) {
          if (key === "destination") return ig;
          const v = target[key];
          return typeof v === "function" ? v.bind(target) : v;
        }
      });
      inst.synth(patchedCtx, this.ctx.currentTime + 0.01, cell.velocity);
    }
    this._notify();
  }

  _showVelPopup(btn, x, y) {
    const popup = this._el.querySelector("#dm-vel-popup");
    const slider = this._el.querySelector("#dm-vel-slider");
    const val = this._el.querySelector("#dm-vel-val");
    const instr = btn.dataset.instr;
    const step  = parseInt(btn.dataset.step, 10);
    const cell  = this._pattern[instr][step];

    slider.value = cell.velocity;
    val.textContent = Math.round(cell.velocity * 100);

    popup.style.display = "flex";
    popup.style.left = Math.min(x, window.innerWidth - 160) + "px";
    popup.style.top  = Math.max(y - 60, 8) + "px";

    const update = e => {
      const v = parseFloat(e.target.value);
      cell.velocity = v;
      val.textContent = Math.round(v * 100);
      const inst = DrumMachine.INSTRUMENTS.find(i => i.id === instr);
      btn.style.opacity = 0.45 + v * 0.55;
      if (cell.active) btn.style.background = inst.color;
    };
    slider.addEventListener("input", update);

    setTimeout(() => {
      document.addEventListener("click", () => {
        popup.style.display = "none";
        slider.removeEventListener("input", update);
      }, { once: true });
    }, 50);
  }

  _closeVelPopup() {
    const popup = this._el?.querySelector("#dm-vel-popup");
    if (popup) popup.style.display = "none";
  }

  _notify() {
    // Framework: tell host state changed (saves with session)
    this.emitStateChange();
    // Legacy callback support
    if (typeof this.onPatternChange === "function") {
      this.onPatternChange(this.getPattern());
    }
  }

  _setStatus(msg) {
    // Legacy method — calls this.notify() which routes to host DAW or console
    this.notify(msg, "info");
    // Also update in-plugin status bar if present
    const el = this._el?.querySelector("#dm-status");
    if (el) { el.textContent = msg; setTimeout(() => { if (el) el.textContent = ""; }, 3000); }
  }

  // ── Presets ──────────────────────────────────────────────────

  _randomize() {
    const densities = { kick:0.2, snare:0.25, clap:0.15, hhc:0.55, hho:0.1, tom_hi:0.1, tom_mid:0.08, ride:0.12 };
    DrumMachine.INSTRUMENTS.forEach(inst => {
      this._pattern[inst.id].forEach((c, i) => {
        c.active   = Math.random() < (densities[inst.id] || 0.2);
        c.velocity = 0.5 + Math.random() * 0.5;
      });
    });
    this._el.innerHTML = this._buildHTML();
    this._bindEvents();
    this._notify();
  }

  _loadPreset(name) {
    const presets = {
      hiphop: {
        kick:    [1,0,0,0, 0,0,1,0, 1,0,0,0, 0,0,1,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],
        snare:   [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],
        clap:    [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],
        hhc:     [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,1, 1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,1],
        hho:     [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,1,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,1,0],
        tom_hi:  [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],
        tom_mid: [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],
        ride:    [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],
        bpm: 90, swing: 30,
      },
      house: {
        kick:    [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0],
        snare:   [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],
        clap:    [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],
        hhc:     [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0],
        hho:     [0,0,0,0, 0,0,1,0, 0,0,0,0, 0,0,1,0, 0,0,0,0, 0,0,1,0, 0,0,0,0, 0,0,1,0],
        tom_hi:  [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,1, 0,0,0,0],
        tom_mid: [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 1,0,0,0],
        ride:    [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],
        bpm: 128, swing: 0,
      },
      techno: {
        kick:    [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0],
        snare:   [0,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0],
        clap:    [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],
        hhc:     [1,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1,1],
        hho:     [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,1, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,1],
        tom_hi:  [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],
        tom_mid: [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],
        ride:    [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],
        bpm: 138, swing: 0,
      },
      jungle: {
        kick:    [1,0,0,0, 0,0,0,0, 0,0,1,0, 0,0,0,0, 1,0,0,0, 0,0,1,0, 0,0,0,0, 0,1,0,0],
        snare:   [0,0,0,0, 0,0,1,0, 0,0,0,0, 1,0,0,0, 0,0,0,0, 0,0,1,0, 0,0,0,0, 1,0,0,1],
        clap:    [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],
        hhc:     [1,0,1,1, 0,1,0,1, 1,0,1,0, 1,1,0,1, 1,0,1,1, 0,1,0,1, 1,0,1,0, 1,1,0,1],
        hho:     [0,0,0,0, 0,0,0,0, 0,1,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,1,0,0, 0,0,0,0],
        tom_hi:  [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0],
        tom_mid: [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,1,0,0, 0,0,0,0],
        ride:    [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],
        bpm: 170, swing: 15,
      },
    };

    const p = presets[name]; if (!p) return;
    if (p.bpm)   { this._bpm = p.bpm; }
    if (p.swing !== undefined) this._swing = p.swing;

    // reset pattern and apply preset (always 32-step extended)
    this._steps = 32;
    DrumMachine.INSTRUMENTS.forEach(inst => {
      const row = p[inst.id] || new Array(32).fill(0);
      this._pattern[inst.id] = Array.from({ length: 32 }, (_, i) => ({
        active:   !!row[i],
        velocity: row[i] ? 0.75 + (i % 4 === 0 ? 0.15 : 0) : 0.8,
      }));
    });
    const wasRunning = this._running;
    if (wasRunning) this.stop();
    this._el.innerHTML = this._buildHTML();
    this._bindEvents();
    if (wasRunning) this.start();
    this.notify(`Loaded: ${name}`, "info");
    this._notify();
  }

  // ── Styles ───────────────────────────────────────────────────

  _injectStyles() {
    if (document.getElementById("dm-styles")) return;
    const style = document.createElement("style");
    style.id = "dm-styles";
    style.textContent = `
      .dm-root {
        --dm-bg:      #100c09;
        --dm-sf:      #1a1410;
        --dm-sf2:     #221c17;
        --dm-sf3:     #2b2219;
        --dm-sf4:     #342a20;
        --dm-br:      rgba(255,107,53,.1);
        --dm-br2:     rgba(255,107,53,.22);
        --dm-br3:     rgba(255,107,53,.36);
        --dm-tx:      #f0e8e2;
        --dm-mt:      #7a6a60;
        --dm-ac:      #ff6b35;
        --dm-ac2:     #ff9a6c;
        --dm-on-bg:   #ff6b35;
        background:   var(--dm-bg);
        color:        var(--dm-tx);
        font-family:  'JetBrains Mono', monospace;
        font-size:    11px;
        border-radius:10px;
        border:       1px solid var(--dm-br2);
        overflow:     hidden;
        user-select:  none;
        min-width:    640px;
      }

      /* HEADER */
      .dm-header {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 12px; flex-wrap: wrap;
        background: var(--dm-sf); border-bottom: 1px solid var(--dm-br2);
      }
      .dm-logo {
        font-family: 'Syne', 'Segoe UI', sans-serif;
        font-size: 13px; font-weight: 800; letter-spacing: 2px;
        color: var(--dm-ac); margin-right: 4px; white-space: nowrap;
      }
      .dm-controls { display:flex; align-items:center; gap:6px; flex-wrap:wrap; flex:1; }
      .dm-actions  { display:flex; gap:5px; margin-left:auto; }
      .dm-sep { width:1px; height:18px; background:var(--dm-br2); margin:0 2px; }
      .dm-label { color:var(--dm-mt); font-size:9px; letter-spacing:.5px; white-space:nowrap; }

      /* BUTTONS */
      .dm-btn {
        padding: 4px 9px; border-radius: 4px; cursor: pointer; font-family:inherit;
        font-size: 10px; font-weight: 600; border: 1px solid var(--dm-br2);
        background: var(--dm-sf2); color: var(--dm-tx); transition: all .1s;
        white-space: nowrap;
      }
      .dm-btn:hover    { background:var(--dm-sf3); border-color:var(--dm-ac); color:var(--dm-ac); }
      .dm-btn.dm-active { background:var(--dm-ac); border-color:var(--dm-ac); color:#fff; }
      .dm-btn:disabled { opacity:.45; cursor:not-allowed; }

      /* INPUTS */
      .dm-num-input {
        background:var(--dm-sf2); border:1px solid var(--dm-br2); color:var(--dm-ac);
        font-family:inherit; font-size:12px; font-weight:700;
        width:44px; padding:3px 5px; border-radius:4px; outline:none; text-align:center;
      }
      .dm-select {
        background:var(--dm-sf2); border:1px solid var(--dm-br2); color:var(--dm-tx);
        font-family:inherit; font-size:10px; padding:3px 5px; border-radius:4px; outline:none;
      }
      .dm-swing-slider, .dm-master-vol {
        -webkit-appearance:none; appearance:none;
        height:3px; background:var(--dm-sf4); border-radius:2px; outline:none; cursor:pointer;
        width:60px;
      }
      .dm-swing-slider::-webkit-slider-thumb, .dm-master-vol::-webkit-slider-thumb {
        -webkit-appearance:none; width:10px; height:10px;
        background:var(--dm-ac); border-radius:50%; cursor:pointer;
      }
      .dm-swing-val { color:var(--dm-ac2); font-size:10px; min-width:28px; }

      /* GRID */
      .dm-grid-wrap { padding: 8px 0; }

      .dm-step-nums-row {
        display: flex; align-items: center; margin-bottom: 2px;
      }
      .dm-row-label-spacer { width: 148px; flex-shrink: 0; }
      .dm-vol-spacer { width: 54px; flex-shrink: 0; }
      .dm-step-nums {
        display: flex; flex: 1; gap: 2px; padding: 0 2px;
      }
      .dm-step-num {
        flex: 1; text-align: center; font-size: 8px; color: var(--dm-mt);
        line-height: 14px; border-radius: 2px; transition: color .08s;
      }
      .dm-bar-num { color: var(--dm-ac2); font-size: 9px; font-weight: 700; }
      .dm-step-num-active { color: #fff !important; }

      /* ROW */
      .dm-row {
        display: flex; align-items: center; padding: 2px 6px 2px 8px; gap: 4px;
        border-bottom: 1px solid var(--dm-br); transition: background .1s;
      }
      .dm-row:hover { background: rgba(255,107,53,.03); }
      .dm-row-label {
        width: 140px; flex-shrink: 0; display: flex;
        align-items: center; gap: 5px; padding-right: 4px;
      }
      .dm-instr-dot {
        width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
      }
      .dm-instr-name {
        font-size: 10px; font-weight: 600; color: var(--dm-tx);
        flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .dm-solo-btn, .dm-mute-btn {
        width: 17px; height: 17px; border-radius: 3px; cursor: pointer;
        font-size: 8px; display: flex; align-items: center; justify-content: center;
        border: 1px solid var(--dm-br2); background: var(--dm-sf3);
        color: var(--dm-mt); transition: all .1s; font-family: inherit; flex-shrink: 0;
      }
      .dm-solo-btn.dm-soloed { background:#ffd166; border-color:#ffd166; color:#111; }
      .dm-mute-btn.dm-muted  { background:#e84040; border-color:#e84040; color:#fff; }
      .dm-solo-btn:hover, .dm-mute-btn:hover { border-color:var(--dm-ac); }

      /* CELLS */
      .dm-cells {
        display: flex; flex: 1; gap: 2px; padding: 0 2px;
      }
      .dm-step {
        flex: 1; height: 30px; border-radius: 4px; border: 1px solid var(--dm-br2);
        background: var(--dm-sf3); cursor: pointer; transition: transform .08s, border-color .08s;
        position: relative; overflow: hidden; padding: 0;
      }
      .dm-step:hover { border-color: var(--dm-ac); transform: scaleY(1.06); }
      .dm-step.dm-group-start { margin-left: 4px; }
      .dm-step.dm-on { border-color: transparent; }
      .dm-step.dm-playing::after {
        content: ''; position: absolute; inset: 0;
        background: rgba(255,255,255,.35); border-radius: 3px;
        animation: dm-flash .08s ease-out forwards;
      }
      @keyframes dm-flash {
        from { opacity: 1; }
        to   { opacity: 0; }
      }

      /* VOL SLIDER */
      .dm-row-vol { width: 50px; flex-shrink: 0; display: flex; align-items: center; padding-left: 4px; }
      .dm-vol-slider {
        -webkit-appearance: none; appearance: none; width: 100%;
        height: 2px; background: var(--dm-sf4); border-radius: 2px; outline: none; cursor: pointer;
      }
      .dm-vol-slider::-webkit-slider-thumb {
        -webkit-appearance: none; width: 8px; height: 8px;
        background: var(--dm-ac); border-radius: 50%; cursor: pointer;
      }

      /* FOOTER */
      .dm-footer {
        display: flex; align-items: center; justify-content: space-between;
        padding: 6px 12px; background: var(--dm-sf); border-top: 1px solid var(--dm-br);
        flex-wrap: wrap; gap: 6px;
      }
      .dm-presets { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
      .dm-status  { font-size: 10px; color: var(--dm-ac2); }

      /* VELOCITY POPUP */
      .dm-vel-popup {
        position: fixed; z-index: 9999;
        background: var(--dm-sf2); border: 1px solid var(--dm-br3); border-radius: 7px;
        padding: 8px 12px; display: flex; align-items: center; gap: 8px;
        box-shadow: 0 8px 28px rgba(0,0,0,.55); font-size: 10px; color: var(--dm-tx);
      }
      #dm-vel-slider {
        -webkit-appearance: none; appearance: none; width: 90px; height: 3px;
        background: var(--dm-sf4); border-radius: 2px; outline: none; cursor: pointer;
        accent-color: var(--dm-ac);
      }
      #dm-vel-slider::-webkit-slider-thumb {
        -webkit-appearance:none; width:10px; height:10px;
        background:var(--dm-ac); border-radius:50%; cursor:pointer;
      }
      #dm-vel-val { color:var(--dm-ac); min-width:22px; text-align:right; font-weight:700; }

      /* RESPONSIVE */
      @media (max-width: 700px) {
        .dm-root     { min-width: unset; font-size: 10px; }
        .dm-step     { height: 24px; }
        .dm-controls { gap: 4px; }
        .dm-logo     { font-size: 11px; }
        .dm-row-label { width: 110px; }
        .dm-row-label-spacer { width: 114px; }
      }
    `;
    document.head.appendChild(style);
  }
}

// ── Export ───────────────────────────────────────────────────
// Requires WavrPlugin to be defined (window.WavrPlugin or imported).
if (typeof module !== "undefined" && module.exports) {
  module.exports = DrumMachine;
} else if (typeof window !== "undefined") {
  window.DrumMachine = DrumMachine;
}
