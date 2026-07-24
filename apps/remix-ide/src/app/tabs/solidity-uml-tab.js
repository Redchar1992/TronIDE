/*
 * Copyright © 2026 TronIDE
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ViewPlugin } from '@remixproject/engine-web'
import * as packageJson from '../../../../../package.json'
const yo = require('yo-yo')
const csjs = require('csjs-inject')

// A sidePanel UML viewer: parses the active .sol with @solidity-parser (already
// bundled) into a Mermaid classDiagram and renders it. The parser-to-mermaid
// module AND mermaid itself are dynamically imported on demand, so they land in
// the lazy "solidity-uml" chunk and never weigh on the main bundle (same pattern
// as the in-editor linter). This is the lightweight alternative to upstream
// Remix's sol2uml + graphviz wasm; chain-agnostic, works on TVM Solidity.

const icon = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="%23888" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="6" rx="1"/><rect x="14" y="3" width="7" height="6" rx="1"/><rect x="8.5" y="15" width="7" height="6" rx="1"/><path d="M6.5 9v3h11V9"/><path d="M12 12v3"/></svg>'

const profile = {
  name: 'solidityUml',
  displayName: 'Solidity UML',
  methods: ['generate'],
  events: [],
  icon,
  description: 'Class/inheritance diagram of the active Solidity file (Mermaid).',
  kind: 'analysis',
  location: 'sidePanel',
  version: packageJson.version
}

const css = csjs`
  .container { padding: 8px; display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
  .head { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .status { font-size: 12px; opacity: 0.8; margin-bottom: 6px; word-break: break-word; }
  .diagram { flex: 1; overflow: auto; border: 1px solid var(--secondary, #444); border-radius: 4px; padding: 6px; min-height: 120px; }
  .diagram svg { max-width: none; height: auto; }
  .src textarea { width: 100%; height: 140px; font-family: monospace; font-size: 11px; white-space: pre; }
`

export class SolidityUmlTab extends ViewPlugin {
  constructor () {
    super(profile)
    this.el = null
    // While a render is in flight, coalesced generate() calls share this
    // promise; it settles with the follow-up render queued in the in-flight
    // run's finally.
    this.pendingGenerate = null
    this._resolvePending = null
    this.state = { status: '', busy: false, svg: '', mermaidText: '', file: '' }
  }

  onActivation () {
    // best-effort: draw the current file as soon as the panel opens
    setTimeout(() => { this.generate().catch((e) => console.error('[solidityUml] generate failed:', e)) }, 0)
    // redraw when the user saves or switches the active file
    const redraw = () => { this.generate().catch((e) => console.error('[solidityUml] redraw failed:', e)) }
    this.on('fileManager', 'fileSaved', redraw)
    this.on('fileManager', 'currentFileChanged', redraw)
  }

  async generate () {
    // A render is already in flight: don't drop this request, and don't resolve
    // it early either. generate() is a bus method (profile.methods), so an
    // awaited call('solidityUml', 'generate') must mean "the diagram now
    // reflects the current file" — every coalesced caller gets a promise that
    // settles with the follow-up render the in-flight run replays in its
    // finally. Without the replay, a save or file-switch during a slow Mermaid
    // load can leave the panel showing the previous file.
    if (this.state.busy) {
      if (!this.pendingGenerate) {
        this.pendingGenerate = new Promise((resolve) => { this._resolvePending = resolve })
      }
      return this.pendingGenerate
    }
    this.state.busy = true
    this.state.status = 'Generating…'
    this.update()
    try {
      const file = await this.call('fileManager', 'getCurrentFile').catch(() => '')
      if (!file || !/\.sol$/.test(file)) {
        this.state.svg = ''; this.state.mermaidText = ''
        this.state.status = 'Open a .sol file, then click Generate.'
        return
      }
      const content = await this.call('fileManager', 'readFile', file)
      const { solToMermaid } = await import(/* webpackChunkName: "solidity-uml" */ './solidity-uml')
      const text = solToMermaid(content)
      this.state.mermaidText = text
      this.state.file = file

      // only a bare "classDiagram" header means nothing to draw
      if (!/class\s+\w/.test(text)) {
        this.state.svg = ''
        this.state.status = `No contracts found in ${file}.`
        return
      }

      const mermaid = (await import(/* webpackChunkName: "solidity-uml" */ 'mermaid')).default
      let dark = false
      try { const t = await this.call('theme', 'currentTheme'); dark = !!(t && /dark/i.test(t.quality || t.name || '')) } catch (e) {}
      // htmlLabels:false is load-bearing: mermaid 11's class renderer honors only
      // this GLOBAL flag (the schema's class.htmlLabels:false default is ignored)
      // and otherwise emits every label as <foreignObject> HTML — which the
      // DOMPurify svg-profile pass below removes wholesale (foreignobject sits in
      // both svgDisallowed and FORBID_CONTENTS), leaving text-less class boxes.
      // With SVG <text> labels the sanitize is lossless.
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', htmlLabels: false })
      const { svg } = await mermaid.render('solidityUmlGraph', text)
      // Defense-in-depth: mermaid 'strict' already sanitizes, and solToMermaid
      // strips non-alphanumerics from identifiers, but sanitize the SVG once more
      // (svg profile) before it touches innerHTML.
      const DOMPurify = (await import(/* webpackChunkName: "solidity-uml" */ 'dompurify')).default
      this.state.svg = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })
      this.state.status = `Diagram for ${file}`
    } catch (e) {
      this.state.svg = ''
      this.state.status = 'UML generation failed: ' + ((e && e.message) || e)
    } finally {
      this.state.busy = false
      this.update()
      // a save/switch arrived mid-render — run the queued follow-up for the
      // latest file and settle the coalesced callers with its outcome. Render
      // failures surface as status text (the catch above), never a rejection,
      // so adopting the promise cannot leak an unhandled rejection into
      // fire-and-forget callers like the Generate button.
      if (this.pendingGenerate) {
        const resolvePending = this._resolvePending
        this.pendingGenerate = null
        this._resolvePending = null
        resolvePending(this.generate())
      }
    }
  }

  async copyMermaid () {
    try {
      await navigator.clipboard.writeText(this.state.mermaidText || '')
      this.state.status = 'Mermaid source copied to clipboard.'
      this.update()
    } catch (e) {
      this.state.status = 'Copy failed: ' + ((e && e.message) || e)
      this.update()
    }
  }

  render () {
    if (!this.el) this.el = this.renderComponent()
    return this.el
  }

  update () {
    if (!this.el) return
    yo.update(this.el, this.renderComponent())
    // Inject the mermaid SVG imperatively (keeps yo-yo out of diffing the SVG).
    const host = this.el.querySelector('[data-id="umlDiagram"]')
    if (host) host.innerHTML = this.state.svg || ''
  }

  renderComponent () {
    const s = this.state
    return yo`
      <div class="${css.container}" data-id="solidityUmlPanel">
        <div class="${css.head}">
          <button class="btn btn-sm btn-primary" data-id="umlGenerate" ${s.busy ? 'disabled' : ''} onclick=${() => this.generate()}>${s.busy ? 'Working…' : 'Generate diagram'}</button>
          ${s.mermaidText ? yo`<button class="btn btn-sm btn-secondary" data-id="umlCopy" ${s.busy ? 'disabled' : ''} onclick=${() => this.copyMermaid()}>Copy Mermaid</button>` : ''}
        </div>
        ${s.status ? yo`<div class="${css.status}" data-id="umlStatus">${s.status}</div>` : ''}
        <div class="${css.diagram}" data-id="umlDiagram"></div>
        ${s.mermaidText ? yo`<details class="${css.src}"><summary>Mermaid source</summary><textarea readonly data-id="umlMermaidText">${s.mermaidText}</textarea></details>` : ''}
      </div>`
  }
}
