---
name: Plugin submission
about: Submit a new plugin for inclusion in the repository
title: '[PLUGIN] '
labels: plugin
assignees: ''
---

**Plugin name**
e.g. Arpeggiator

**Category**
instrument / effect / utility / generator

**Description**
What does your plugin do? One paragraph.

**Files included**
- [ ] `PluginName.js` — extends WavrPlugin
- [ ] `test.html` — standalone test harness

**Checklist**
- [ ] Extends `WavrPlugin`
- [ ] All four required methods implemented (mount, destroy, getState, setState)
- [ ] `super.destroy()` called last in destroy()
- [ ] Uses `this.ctx`, does not create its own AudioContext
- [ ] All CSS classes prefixed with pluginId
- [ ] `getState()` returns only plain JSON
- [ ] Works standalone: `new MyPlugin({ audioContext, bpm }).mount(el)`

**Link to code or PR**
