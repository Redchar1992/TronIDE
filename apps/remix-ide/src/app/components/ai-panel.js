/*
 * Copyright 2022 [TronIDE]
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

import { AbstractPanel } from './panel'
import * as packageJson from '../../../../../package.json'
import CodeReader from '@remix-code-reader'
import React from 'react'  // eslint-disable-line
import ReactDOM from 'react-dom'

const EventEmitter = require('events')
const yo = require('yo-yo')
const csjs = require('csjs-inject')

const css = csjs`
  .pluginsContainer {
    width: 100%;
    height: 100%;
    display: flex;
    overflow-y: hidden;
  }
`

const profile = {
  name: 'aiPanel',
  displayName: 'Ai Panel',
  description: '',
  version: packageJson.version,
  methods: ['addView', 'removeView', 'hide', 'ask', 'explainError', 'explainContract', 'aiComplete', 'hasAiKey']
}

export class AiPanel extends AbstractPanel {
  constructor (appManager, config) {
    super(profile)
    this.appManager = appManager
    this.config = config
    this.init()
    this.events = new EventEmitter()
  }

  focus (name) {
    this.emit('focusChanged', name)
    super.focus(name)
  }

  async showContent (name) {
    super.showContent(name)
  }

  init () {
    this.appManager.event.on('activate', ({ name, location, displayName, icon }) => {
      if (location === 'aiPanel') {
        this.showContent(name)
      }
    })
  }

  // Ensure the AI panel is visible (mirrors the "show" half of hide()'s toggle)
  // without flipping it closed when it is already open. Re-renders CodeReader so
  // the Chat component is mounted before we inject a prompt.
  reveal () {
    const el = document.getElementById('ai-panel')
    if (!el) return
    const isHidden = el.style.display === 'none' || el.style.width === '0px'
    if (isHidden) {
      el.style.display = 'flex'
      el.style.minWidth = '340px'
      el.style.width = el.dataset.previousWidth || '340px'
      const previousSibling = el.previousElementSibling
      if (previousSibling) previousSibling.style.display = 'block'
      this.aiPanelvisible = true
      ReactDOM.render(
        <CodeReader
          plugin={this}
          aiPanelvisible={this.aiPanelvisible}
        />,
        this.aiPanelEl
      )
      this.emit('aiPluginClosed', false)
    }
  }

  // Reveal the panel and push a ready-made prompt into the chat. We wait a tick
  // so a just-mounted Chat has subscribed to 'injectPrompt' before we emit. The
  // chat handles the unset-key / in-flight cases itself, so this never throws.
  async ask (prompt) {
    if (!prompt) return
    this.reveal()
    setTimeout(() => {
      this.events.emit('injectPrompt', { prompt })
    }, 150)
  }

  async explainError ({ message, file, line, code } = {}) {
    const location = file ? `${file}${line ? `:${line}` : ''}` : ''
    let prompt = 'Explain this Solidity compiler error and how to fix it'
    if (location) prompt += ` (at ${location})`
    prompt += `:\n\n${message || ''}`
    if (code) prompt += `\n\nRelevant code:\n${code}`
    return this.ask(prompt)
  }

  // Run an AI completion INSIDE the panel and return only the text. The key
  // never crosses the plugin RPC boundary (the mounted Chat holds it and does
  // the request via _aiCompleteFn). Returns '' when the panel was never opened
  // or no key is set. The editor's completer / inline-`//` use this.
  async aiComplete ({ prefix, suffix, maxTokens } = {}) {
    if (typeof this._aiCompleteFn === 'function') return this._aiCompleteFn({ prefix, suffix, maxTokens })
    return ''
  }

  // Non-secret: whether a key is set, so callers can show a "set a key" hint.
  async hasAiKey () {
    return typeof this._hasAiKeyFn === 'function' ? !!this._hasAiKeyFn() : false
  }

  async explainContract ({ code, file } = {}) {
    if (!code) return
    const header = file ? `Explain the following Solidity contract (${file}). ` : 'Explain the following Solidity contract. '
    const prompt = `${header}Describe what it does, its main functions, and call out any obvious risks:\n\n${code}`
    return this.ask(prompt)
  }

  async hide () {
    const el = document.getElementById('ai-panel')
    if (el) {
      const shouldShow = el.style.display === 'none'
      if (!shouldShow) el.dataset.previousWidth = el.style.width || `${el.getBoundingClientRect().width}px` || '340px'
      el.style.display = shouldShow ? 'flex' : 'none'
      el.style.minWidth = shouldShow ? '340px' : '0px'
      el.style.width = shouldShow ? (el.dataset.previousWidth || '340px') : '0px'
      const previousSibling = el.previousElementSibling
      if (previousSibling) previousSibling.style.display = shouldShow ? 'block' : 'none'
      this.aiPanelvisible = shouldShow
      ReactDOM.render(
        <CodeReader
          plugin={this}
          aiPanelvisible={this.aiPanelvisible}
        />,
        this.aiPanelEl
      )
      // this.events?.emit('aiPluginClosed', !this.aiPanelvisible)
      this.emit('aiPluginClosed', !shouldShow)
    }
  }

  render () {
    const el = yo`
      <div class=${css.pluginsContainer} data-id="aiPanelPluginsContainer">
        ${this.view}
      </div>`
    ReactDOM.render(
      <CodeReader
        plugin={this}
      />,
      el
    )
    this.aiPanelEl = el
    return el
  }
}
