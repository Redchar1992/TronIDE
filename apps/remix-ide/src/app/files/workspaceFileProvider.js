/*
 * Original work Copyright © 2018-2021 Remix Team
 * Licensed under the MIT License.
 *
 * Modifications Copyright © 2022 TronIDE
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

'use strict'

const EventManager = require('events')
const FileProvider = require('./fileProvider')
const pathModule = require('path')
const lastWorkspace = require('../../lib/last-workspace')

class WorkspaceFileProvider extends FileProvider {
  constructor () {
    super('')
    this.workspacesPath = '.workspaces'
    this.workspace = null
    this.event = new EventManager()
    this._gitRewriteToken = null
    this._gitRewriteAuthorization = null
    this._writeGeneration = 0
  }

  captureMutationContext () {
    return { workspace: this.workspace, generation: this._writeGeneration }
  }

  beginGitWorkspaceRewrite (token) {
    if (this._gitRewriteToken !== null) throw new Error('Another Git workspace rewrite is already in progress.')
    // Invalidate async writes that started before the rewrite. They must stay
    // stale even if they resume only after the temporary lock is released.
    this._writeGeneration++
    this._gitRewriteToken = token
    return true
  }

  endGitWorkspaceRewrite (token) {
    if (this._gitRewriteToken !== token) return false
    this._gitRewriteToken = null
    this._gitRewriteAuthorization = null
    // Likewise reject any non-owner intent captured while the rewrite lock was
    // active once normal writes resume.
    this._writeGeneration++
    return true
  }

  _assertGitWriteAllowed (action, context) {
    const token = typeof context === 'number' ? context : context && context.rewriteToken
    if (context && typeof context === 'object' && !Object.prototype.hasOwnProperty.call(context, 'rewriteToken')) {
      if (context.workspace !== this.workspace || context.generation !== this._writeGeneration) {
        throw new Error(`Cannot ${action} because the workspace changed after the operation started.`)
      }
    }
    if (this._gitRewriteToken === null ||
      this._gitRewriteToken === token ||
      this._gitRewriteAuthorization === this._gitRewriteToken) return
    throw new Error(`Cannot ${action} while Git is switching or updating the workspace.`)
  }

  _withGitWriteAuthorization (context, action, fn) {
    this._assertGitWriteAllowed(action, context)
    const token = typeof context === 'number' ? context : context && context.rewriteToken
    const previous = this._gitRewriteAuthorization
    if (this._gitRewriteToken !== null && token === this._gitRewriteToken) this._gitRewriteAuthorization = token
    try { return fn() } finally { this._gitRewriteAuthorization = previous }
  }

  // Guard at the workspace-provider boundary, not only FileManager's async
  // entry points. File uploads and several legacy callers write through the
  // provider directly; an operation that started before checkout can also
  // resume after an await. These mutations are synchronous in BrowserFS, so
  // checking in the same JS stack as the actual write closes that TOCTOU.
  set (path, content, cb, mutationContext) {
    try {
      return this._withGitWriteAuthorization(mutationContext, 'write files', () => super.set(path, content, cb))
    } catch (error) {
      if (cb) cb(error)
      return false
    }
  }

  createDir (path, cb, mutationContext) {
    return this._withGitWriteAuthorization(mutationContext, 'create folders', () => super.createDir(path, cb))
  }

  remove (path, mutationContext) {
    return this._withGitWriteAuthorization(mutationContext, 'remove files', () => super.remove(path))
  }

  removeFile (path, mutationContext) {
    return this._withGitWriteAuthorization(mutationContext, 'remove files', () => super.removeFile(path))
  }

  rename (oldPath, newPath, isFolder, mutationContext) {
    return this._withGitWriteAuthorization(mutationContext, 'rename files', () => super.rename(oldPath, newPath, isFolder))
  }

  setWorkspace (workspace) {
    this._assertGitWriteAllowed('switch workspaces')
    workspace = workspace.replace(/^\/|\/$/g, '') // remove first and last slash
    if (workspace !== this.workspace) this._writeGeneration++
    this.workspace = workspace
    // restore-on-boot marker: the file panel prefers this over the first
    // directory-listing entry, so a fresh session reopens the last workspace.
    // The module owns the writer rules (transient link-landing workspaces
    // never stamp; stamping is muted while a clone target is provisional).
    lastWorkspace.set(workspace)
  }

  getWorkspace () {
    return this.workspace
  }

  /**
   * Compare-and-set a workspace file without yielding between the comparison
   * and the write. Callers that confirmed a previous state can therefore avoid
   * overwriting a user edit that lands during an earlier asynchronous read.
   */
  setIfUnchanged (path, content, expectedState, cb, mutationContext) {
    cb = cb || function () {}
    try {
      if (!expectedState || typeof expectedState.exists !== 'boolean' ||
        (expectedState.exists && typeof expectedState.content !== 'string')) {
        const invalidState = new Error('A valid expected file state is required.')
        invalidState.code = 'AI_FILE_CHANGED'
        cb(invalidState)
        return false
      }
      const unprefixedPath = this.removePrefix(path)
      const exists = window.remixFileSystem.existsSync(unprefixedPath)
      const currentContent = exists ? String(window.remixFileSystem.readFileSync(unprefixedPath, 'utf8') ?? '') : null
      const unchanged = exists === expectedState.exists &&
        (!exists || currentContent === expectedState.content)
      if (!unchanged) {
        const changed = new Error('The file changed after it was confirmed.')
        changed.code = 'AI_FILE_CHANGED'
        cb(changed)
        return false
      }
    } catch (error) {
      cb(error)
      return false
    }
    // FileProvider#set performs a synchronous BrowserFS write. Calling it in
    // this same stack makes the state comparison and mutation indivisible with
    // respect to normal UI events/workspace switches.
    return this.set(path, content, cb, mutationContext)
  }

  isReady () {
    return this.workspace !== null
  }

  clearWorkspace () {
    this._assertGitWriteAllowed('clear the workspace')
    if (this.workspace !== null) this._writeGeneration++
    this.workspace = null
  }

  removePrefix (path) {
    if (!this.workspace) this.createWorkspace()
    path = path.replace(/^\/|\/$/g, '') // remove first and last slash
    if (path.startsWith(this.workspacesPath + '/' + this.workspace)) return path
    if (path.startsWith(this.workspace)) return path.replace(this.workspace, this.workspacesPath + '/' + this.workspace)
    path = super.removePrefix(path)
    let ret = this.workspacesPath + '/' + this.workspace + '/' + (path === '/' ? '' : path)

    ret = ret.replace(/^\/|\/$/g, '')
    if (!this.isSubDirectory(this.workspacesPath + '/' + this.workspace, ret)) throw new Error('Cannot read/write to path outside workspace')
    return ret
  }

  isSubDirectory (parent, child) {
    if (!parent) return false
    if (parent === child) return true
    const relative = pathModule.relative(parent, child)

    return !!relative && relative.split(pathModule.sep)[0] !== '..'
  }

  resolveDirectory (path, callback) {
    if (!this.workspace) this.createWorkspace()
    super.resolveDirectory(path, (error, files) => {
      if (error) return callback(error)
      const unscoped = {}
      for (const file in files) {
        unscoped[file.replace(this.workspacesPath + '/' + this.workspace + '/', '')] = files[file]
      }
      callback(null, unscoped)
    })
  }

  async copyFolderToJson (directory, visitFile, visitFolder) {
    visitFile = visitFile || (() => {})
    visitFolder = visitFolder || (() => {})
    const regex = new RegExp(`.workspaces/${this.workspace}/`, 'g')
    let json = await super._copyFolderToJsonInternal(directory, ({ path, content }) => {
      visitFile({ path: path.replace(regex, ''), content })
    }, ({ path }) => {
      visitFolder({ path: path.replace(regex, '') })
    })
    json = JSON.stringify(json).replace(regex, '')
    return JSON.parse(json)
  }

  _normalizePath (path) {
    if (!this.workspace) this.createWorkspace()
    return path.replace(this.workspacesPath + '/' + this.workspace + '/', '')
  }

  createWorkspace (name) {
    this._assertGitWriteAllowed('create workspaces')
    if (!name) name = 'default_workspace'
    this.event.emit('createWorkspace', name)
  }
}

module.exports = WorkspaceFileProvider
