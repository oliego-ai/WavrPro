# Contributing to WAVR PRO

Thanks for your interest in contributing. This guide covers everything from filing a good bug report to submitting a plugin or SDK change.

---

## Types of contribution

| Type | Where | Guide |
|---|---|---|
| Bug fix · core DAW | `src/WavrPro.jsx` | [DAW bugs](#daw-bugs) |
| New feature · core DAW | `src/WavrPro.jsx` | [DAW features](#daw-features) |
| New plugin | `plugins/` | [Plugins](#plugins) |
| SDK improvement | `plugin-sdk/` | [Plugin SDK](#plugin-sdk) |
| Documentation | `README.md`, `COMMUNITY.md` | [Docs](#documentation) |
| GitHub Pages site | `docs/` | [Site](#site) |

---

## Before you open a PR

1. **Check open issues** — someone may already be working on it
2. **Open an issue first** for any non-trivial change — a quick alignment check saves everyone time
3. **Keep PRs focused** — one concern per PR, even if small. Bundled changes are harder to review and harder to revert

---

## DAW bugs

A good bug report includes:

- Browser and version
- Steps to reproduce (exact sequence of clicks/drags)
- Expected behaviour vs actual behaviour
- Console errors if any (F12 → Console)
- A `.wavrproj` file that demonstrates the problem if relevant

### Audio bugs specifically

The most common audio issues involve AudioParam values. The rule is: **every value written to an AudioParam must pass `Number.isFinite()` before assignment**. If you're fixing a crash like `Failed to set the 'value' property on 'AudioParam': The provided float value is non-finite`, the fix is always sanitization at the boundary where data enters the audio graph (loading from IDB, history restore, `.wavrproj` import).

Use the existing `sanitizeEQ()` function pattern as a model.

---

## DAW features

Features most likely to be accepted:

- Improvements to the transport (better pause-in-place behaviour, loop region support)
- Additional clip operations (fade in/out, gain automation)
- Better `.wavrproj` format handling
- Visualizer improvements
- Accessibility improvements (keyboard navigation, screen reader labels)

Features that need discussion first (open an issue):

- Any change to the session serialization format — must remain backwards compatible
- New top-level state fields — affects undo/redo history shape
- Changes to the plugin HostAPI surface — affects all existing plugins

### Code style

WavrPro.jsx follows a few conventions worth matching:

- **Refs for audio, state for UI.** If it's on the timing path, use a ref. If it triggers a re-render, use state.
- **Mirror refs to state where needed.** `tracksRef.current = tracks` is intentional — audio callbacks capture the ref, React renders from state.
- **Guard all AudioParam writes.** `Number.isFinite(v) ? v : fallback` before every `.value =` assignment.
- **Inline styles are acceptable** for dynamic values (clip widths, VU heights). Static styles go in the `STYLES` constant at the top.

---

## Plugins

New plugins live in `plugins/YourPlugin/`. The minimum required files:

```
plugins/
└── YourPlugin/
    ├── YourPlugin.js       Pure JS class extending WavrPlugin
    ├── YourPluginPlugin.jsx  React wrapper (optional — use PluginShell generically if possible)
    └── test.html           Self-contained test harness
```

### Plugin requirements checklist

- [ ] Extends `WavrPlugin` from `plugin-sdk/src/WavrPlugin.js`
- [ ] Has all required static fields: `pluginId`, `pluginName`, `pluginColor`
- [ ] Implements `mount(el)`, `destroy()`, `getState()`, `setState(s)`
- [ ] Calls `super.destroy()` **last** in `destroy()`
- [ ] Uses `this.ctx` — does not create its own `AudioContext`
- [ ] Disconnects all audio nodes in `destroy()`
- [ ] All CSS class names prefixed with `pluginId` to avoid collisions
- [ ] `getState()` returns only plain JSON — no AudioBuffers, no DOM refs
- [ ] Includes a `test.html` that demonstrates it working without WavrPro
- [ ] Works with the legacy standalone call: `new MyPlugin({ audioContext, bpm }).mount(el)`

See `COMMUNITY.md` for the full public-facing guide, and `plugin-sdk/examples/ExamplePlugin.js` for a minimal working example.

---

## Plugin SDK

The SDK (`plugin-sdk/`) follows a stability-first philosophy. The `WavrPlugin` base class contract and the `HostAPI` interface are the public surfaces — changes here require discussion first because they affect every plugin author.

**Safe to change without discussion:**
- Internal implementation details of `PluginShell.jsx` or `usePluginManager.js` that don't change their API
- Adding new optional methods to `WavrPlugin` (new transport hooks, new helpers)
- Documentation improvements

**Requires a GitHub issue first:**
- Any change to required plugin methods (`mount`, `destroy`, `getState`, `setState`)
- Any change to `HostAPI` shape (adding, removing, or renaming methods)
- Any change to how `pluginStates` serializes in the session format

---

## Documentation

Documentation PRs are always welcome. When editing:

- `README.md` — keep the technical accuracy high. If a code example is in here, it should actually work.
- `COMMUNITY.md` — public-facing, aimed at plugin authors. Should not contain WavrPro internal implementation details.
- `plugin-sdk/README.md` — developer-focused API reference. Completeness matters more than brevity here.
- `docs/` — the GitHub Pages site. See [Site](#site) below.

---

## Site

The `docs/` directory is deployed to GitHub Pages. All pages are self-contained HTML — no build step, no Jekyll.

When editing site files:
- Test locally by opening the file directly in a browser (or running `python3 -m http.server` in `docs/`)
- The demo pages (`wavr-demo.html`, `sdk-demo.html`) embed the actual DAW and plugin — changes to `public/` and `plugin-sdk/` should be tested against the demo pages
- Keep page load size reasonable — the SDK demo embeds ~80KB of JS, which is the floor

---

## Commit messages

No rigid format required, but aim for:

```
fix: guard AudioParam assignment in buildEQChain
feat: add pause-in-place to transport
plugin: add arpeggiator plugin to plugins/
sdk: add onPlayheadTick broadcasting to usePluginManager
docs: update plugin authoring checklist in COMMUNITY.md
```

---

## Code of conduct

Be direct. Be constructive. Audio software has a lot of edge cases — if something is broken, describe it precisely. If something could be better, explain why and propose something. Assume good faith.

---

## Licence

By contributing, you agree that your contributions will be licensed under the MIT licence.
