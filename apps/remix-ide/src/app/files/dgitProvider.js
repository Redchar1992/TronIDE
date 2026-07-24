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

import {
  Plugin
} from '@remixproject/engine'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import IpfsHttpClient from 'ipfs-http-client'
import {
  saveAs
} from 'file-saver'
import * as githubAuth from '../../lib/github-auth'

const JSZip = require('jszip')
const path = require('path')
const FormData = require('form-data')
const axios = require('axios')

// CORS proxy for isomorphic-git smart-HTTP. The IDE is a static site so the
// browser cannot reach github.com's git endpoints directly; isomorphic-git
// routes every request through this proxy (our Deno OAuth service, which also
// hosts the `/git/` forwarder). Change here if the Deno deployment URL changes.
const GIT_CORS_PROXY = 'https://tronide-gh-oauth.redchar1992.deno.net/git'

// A trailing slash in a pasted repo URL (github.com/owner/repo/) survives into
// the proxied path as '//', which the proxy's SSRF guard rejects — normalize
// before it reaches isomorphic-git. Real git accepts both forms.
function normalizeGitUrl (url) {
  if (!url) return undefined
  return String(url).trim().replace(/\/+$/, '')
}

// isomorphic-git auth callback. GitHub accepts the personal/OAuth token as the
// HTTP-basic *username* with a fixed password. The token now lives only in
// memory (lib/github-auth) — never in sessionStorage — so we read it from there.
// If absent (e.g. after a full reload), fail loudly so the UI can point the user
// at "Connect to GitHub" instead of hanging on a 401 loop.
function gitOnAuth () {
  const token = githubAuth.getToken()
  if (!token) throw new Error('Connect GitHub first (use the "Connect to GitHub" button).')
  return { username: token, password: 'x-oauth-basic' }
}

// Pinata calls carry the pinata_secret_api_key in axios request headers. On
// failure, never surface the raw axios error object (its `config.headers` holds
// that secret) — extract only the HTTP status and Pinata's own message.
function redactPinataError (error) {
  const status = error && error.response && error.response.status
  const data = error && error.response && error.response.data
  const detail =
    (data && ((data.error && (data.error.reason || data.error)) || data.message)) ||
    (error && error.response && error.response.statusText) ||
    (error && error.message) ||
    'unknown error'
  return (status ? status + ' ' : '') + (typeof detail === 'string' ? detail : 'request failed')
}

const profile = {
  name: 'dGitProvider',
  displayName: 'Decentralized git',
  description: '',
  icon: 'assets/img/fileManager.webp',
  version: '0.0.1',
  methods: ['init', 'status', 'log', 'commit', 'add', 'remove', 'rm', 'resetIndex', 'lsfiles', 'readblob', 'resolveref', 'branches', 'branch', 'checkout', 'currentbranch', 'workspaceIdentity', 'push', 'pin', 'pull', 'pinList', 'unPin', 'setIpfsConfig', 'zip', 'clone', 'fetchRemote', 'pullRemote', 'pushRemote', 'addRemote', 'listRemotes'],
  events: ['gitChanged'],
  kind: 'file-system'
}
class DGitProvider extends Plugin {
  constructor () {
    super(profile)
    this._gitMutationOwner = null
    this._gitMutationSequence = 0
    this.ipfsconfig = {
      host: 'ipfs.remixproject.org',
      port: 443,
      protocol: 'https',
      ipfsurl: 'https://ipfs.remixproject.org/ipfs/'
    }
    this.globalIPFSConfig = {
      host: 'ipfs.io',
      port: 443,
      protocol: 'https',
      ipfsurl: 'https://ipfs.io/ipfs/'
    }
  }

  // isomorphic-git 1.36 binds a fixed command list onto the fs, including
  // `cp` — which the browser fs (BrowserFS) does not provide, so binding it
  // throws "Cannot read properties of undefined (reading 'bind')". Wrap the
  // real fs once and fill in the methods it lacks (callback-style, so
  // isomorphic-git's pify wrapper handles them).
  _gitFs () {
    if (this._wrappedFs) return this._wrappedFs
    const real = window.remixFileSystem
    if (!real || typeof real.cp === 'function') return real
    const wrapped = Object.create(real)
    if (typeof real.cp !== 'function') {
      wrapped.cp = (src, dest, optsOrCb, maybeCb) => {
        const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb
        real.readFile(src, (err, data) => {
          if (err) return cb(err)
          real.writeFile(dest, data, (werr) => cb(werr))
        })
      }
    }
    this._wrappedFs = wrapped
    return wrapped
  }

  async getGitConfig () {
    const workspace = await this.call('filePanel', 'getCurrentWorkspace')
    return {
      fs: this._gitFs(),
      dir: workspace.absolutePath
    }
  }

  // Return the provider's absolute workspace root. Git confirmations use this
  // stable identity rather than the file-panel display name, which may be
  // unavailable to a nested plugin call even though the Git provider itself
  // can still resolve the active workspace.
  async workspaceIdentity () {
    return (await this.getGitConfig()).dir
  }

  _beginGitMutation (action) {
    if (this._gitMutationOwner) {
      throw new Error(`Another Git operation is already in progress. Retry ${action} when it finishes.`)
    }
    const token = ++this._gitMutationSequence
    this._gitMutationOwner = token
    return token
  }

  _endGitMutation (token) {
    if (this._gitMutationOwner === token) this._gitMutationOwner = null
  }

  _emitGitChanged (operation) {
    // File-system events do not cover index/ref-only changes (stage, commit,
    // branch, fetch). Publish one provider-level signal so every caller,
    // including AI tools, keeps an already-open Git panel in sync.
    this.emit('gitChanged', { operation })
  }

  async _mutationContext (cmd = {}) {
    const { expectedWorkspace, expectedBranch, ...gitCmd } = cmd
    const config = await this.getGitConfig()
    if (expectedWorkspace && config.dir !== expectedWorkspace) {
      throw new Error('Workspace changed before the Git operation started. Nothing was changed.')
    }
    if (Object.prototype.hasOwnProperty.call(cmd, 'expectedBranch')) {
      let currentBranch = ''
      try { currentBranch = await git.currentBranch(config) || '' } catch (e) { currentBranch = '' }
      if (currentBranch !== expectedBranch) {
        throw new Error('Branch changed before the Git operation started. Nothing was changed.')
      }
    }
    return { config, gitCmd }
  }

  async init (cmd = {}) {
    const mutationToken = this._beginGitMutation('initializing the repository')
    try {
      const { config } = await this._mutationContext(cmd)
      await git.init({
        ...config,
        defaultBranch: 'main'
      })
      this._emitGitChanged('init')
    } finally {
      this._endGitMutation(mutationToken)
    }
  }

  async status (cmd) {
    const config = await this.getGitConfig()
    return this._verifiedStatusMatrix(config, cmd)
  }

  async add (cmd) {
    const mutationToken = this._beginGitMutation('staging files')
    try {
      const { config, gitCmd } = await this._mutationContext(cmd)
      await git.add({ ...config, ...gitCmd })
      await this.call('fileManager', 'refresh')
      this._emitGitChanged('add')
    } finally {
      this._endGitMutation(mutationToken)
    }
  }

  async rm (cmd) {
    const mutationToken = this._beginGitMutation('staging file deletions')
    try {
      const { config, gitCmd } = await this._mutationContext(cmd)
      await git.remove({ ...config, ...gitCmd })
      await this.call('fileManager', 'refresh')
      this._emitGitChanged('rm')
    } finally {
      this._endGitMutation(mutationToken)
    }
  }

  // Unstage: reset the file's INDEX entry back to HEAD. git.remove would delete
  // the index entry entirely, silently staging a file DELETION for tracked
  // files — a later commit+push would then remove the file from the remote.
  async resetIndex (cmd) {
    const mutationToken = this._beginGitMutation('unstaging files')
    try {
      const { config, gitCmd } = await this._mutationContext(cmd)
      await git.resetIndex({ ...config, ...gitCmd })
      await this.call('fileManager', 'refresh')
      this._emitGitChanged('resetIndex')
    } finally {
      this._endGitMutation(mutationToken)
    }
  }

  async _readlinkBytes (fsClient, filepath) {
    let value
    if (fsClient.promises && typeof fsClient.promises.readlink === 'function') {
      value = await fsClient.promises.readlink(filepath)
    } else {
      value = await new Promise((resolve, reject) => {
        fsClient.readlink(filepath, (error, target) => error ? reject(error) : resolve(target))
      })
    }
    if (value == null) return null
    return typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)
  }

  async _forcedTrackedWorktreeDiff (config) {
    const rows = await git.walk({
      ...config,
      trees: [git.WORKDIR(), git.STAGE()],
      map: async (filepath, [workdir, stage]) => {
        if (filepath === '.') return
        const [workdirType, stageType] = await Promise.all([
          workdir && workdir.type(),
          stage && stage.type()
        ])

        // Only force-hash paths known to the index. Pruning a worktree-only
        // tree excludes .git, ignored content, and empty directories.
        if (!stageType) return workdirType === 'tree' ? null : undefined
        // Git tracks descendants, not directory entries themselves.
        if (stageType === 'tree') {
          if (workdirType && workdirType !== 'tree') return filepath
          return
        }
        // isomorphic-git represents a gitlink/submodule index entry as a
        // commit and does not update its nested worktree during checkout.
        if (stageType === 'commit') return null
        if (stageType !== 'blob' || workdirType !== 'blob') return filepath

        const [workdirMode, stageMode, stageOid] = await Promise.all([
          workdir.mode(), stage.mode(), stage.oid()
        ])
        const workdirIsSymlink = workdirMode === 0o120000
        const stageIsSymlink = stageMode === 0o120000
        // Repositories are initialized with core.filemode=false, so an
        // executable-bit-only difference is intentionally clean. A symlink
        // versus regular-file change still alters the tracked object type.
        if (workdirIsSymlink !== stageIsSymlink || !stageOid) return filepath

        // statusMatrix may trust same-size, same-second file stats and miss a
        // content change. Hash bytes on every safety-critical checkout/pull.
        // WORKDIR.content follows symlinks, so hash the link target for 120000.
        const object = stageIsSymlink
          ? await this._readlinkBytes(config.fs, path.join(config.dir, filepath))
          : await workdir.content()
        if (object == null) return filepath
        const { oid: workdirOid } = await git.hashBlob({ object })
        return workdirOid === stageOid ? undefined : filepath
      }
    })
    return rows.filter(Boolean)
  }

  async _verifiedStatusMatrix (config, cmd = {}) {
    const matrix = await git.statusMatrix({ ...config, ...cmd })
    const forced = new Set(await this._forcedTrackedWorktreeDiff(config))
    if (!forced.size) return matrix

    // statusMatrix reuses the index oid when size and whole-second timestamps
    // match. A same-length edit saved in that second is otherwise reported as
    // permanently clean. Translate the independently hashed mismatch back to
    // valid statusMatrix codes so every panel/tool can see and stage it.
    return matrix.map((row) => {
      if (!forced.has(row[0]) || row[2] !== row[3]) return row
      const [filepath, head, workdir, stage] = row
      if (stage === head) return [filepath, head, 2, stage]
      return [filepath, head, workdir, 3]
    })
  }

  async _assertCleanWorktree (config, action, rewriteToken) {
    // Include the active Ace buffer in the safety decision even if its normal
    // autosave debounce has not fired yet.
    await this.call('fileManager', 'saveCurrentFileChecked', rewriteToken)
    const matrix = await this._verifiedStatusMatrix(config)
    const dirty = matrix.some(([, head, workdir, stage]) => stage !== head || workdir !== stage)
    if (dirty) {
      throw new Error(`Commit or discard all changes before ${action}. Staging alone is not sufficient.`)
    }
    return matrix
  }

  async _assertRewriteCompleted (config, action) {
    const matrix = await this._verifiedStatusMatrix(config)
    if (matrix.some(([, head, workdir, stage]) => stage !== head || workdir !== stage)) {
      throw new Error(`${action} did not fully update the worktree. Git kept the files that reached disk, and the editor was re-synchronised; review the reported changes before continuing.`)
    }
    return matrix
  }

  async checkout (cmd) {
    const mutationToken = this._beginGitMutation('switching branches')
    let rewriteToken
    let config
    let checkoutStarted = false
    let operationError = null
    const rewritePaths = new Set()
    try {
      // Lock the active editor before saving/checking. This closes the remaining
      // check-to-checkout window and also serializes concurrent rewrites.
      rewriteToken = await this.call('fileManager', 'beginWorkspaceRewrite', { warningAfterMs: 65000 })
      const mutation = await this._mutationContext(cmd)
      config = mutation.config
      // isomorphic-git 1.36 can silently overwrite staged changes and unstaged
      // deletions during checkout. Keep this guard at the provider boundary so
      // a future caller cannot bypass the panel/AI safety checks.
      const beforeMatrix = await this._assertCleanWorktree(config, 'switching branches', rewriteToken)
      beforeMatrix.forEach((row) => rewritePaths.add(row[0]))
      if ((await this.getGitConfig()).dir !== config.dir) {
        throw new Error('Workspace changed while switching branches. Checkout cancelled.')
      }
      checkoutStarted = true
      await git.checkout({
        ...config,
        ...mutation.gitCmd
      })
      const afterMatrix = await this._assertRewriteCompleted(config, 'Checkout')
      afterMatrix.forEach((row) => rewritePaths.add(row[0]))
    } catch (error) {
      operationError = error
    }

    let reconciliationError = null
    let unlockError = null
    try {
      // A checkout can fail after partially rewriting BrowserFS. Reconcile
      // from the bytes that actually landed on BOTH success and failure paths.
      // Do not gate this safety step on another fallible workspace RPC: if that
      // lookup rejects, unlocking the old Ace buffer would let autosave corrupt
      // the newly checked-out bytes.
      if (checkoutStarted && config) {
        try {
          const landedMatrix = await this._verifiedStatusMatrix(config)
          landedMatrix.forEach((row) => rewritePaths.add(row[0]))
        } catch (error) { /* best-effort path hints; editor reconciliation remains mandatory */ }
        try { await this.call('fileManager', 'refresh', [...rewritePaths]) } catch (error) { console.warn('Could not refresh the file explorer after checkout:', error) }
        try { await this._resyncCurrentEditor(rewriteToken) } catch (error) { reconciliationError = error }
      }

      // Fail closed. A known-stale editor is kept read-only if reconciliation
      // failed; the user is told to reload instead of being allowed to autosave
      // source-branch content over the target branch.
      if (rewriteToken !== undefined && !reconciliationError) {
        try {
          const unlocked = await this.call('fileManager', 'endWorkspaceRewrite', rewriteToken)
          if (unlocked !== true) unlockError = new Error('The editor rejected the Git rewrite token.')
        } catch (error) { unlockError = error }
      }
    } finally {
      // A failed reconcile/unlock poisons the session until reload. Keep the
      // provider mutation lease as well as the editor lock so a direct or AI
      // commit/push cannot publish a partially rewritten worktree.
      if (!reconciliationError && !unlockError) this._endGitMutation(mutationToken)
    }

    if (reconciliationError) {
      const original = operationError ? `${(operationError && operationError.message) || operationError} ` : ''
      throw new Error(`${original}The editor could not be reconciled after checkout and remains protected. Reload TronIDE before editing. Details: ${(reconciliationError && reconciliationError.message) || reconciliationError}`)
    }
    if (unlockError) {
      const original = operationError ? `${(operationError && operationError.message) || operationError} ` : ''
      throw new Error(`${original}Checkout finished, but the editor safety lock could not be released. Reload TronIDE. Details: ${(unlockError && unlockError.message) || unlockError}`)
    }
    if (operationError) throw operationError
    this._emitGitChanged('checkout')
  }

  // checkout/pull rewrite worktree files behind the providers' back (raw
  // BrowserFS), so the open editor session still shows the PRE-op content.
  // Left alone, the next tab switch (fileManager.openFile saves the current
  // file first) or the idle autosave would write that stale buffer back over
  // the fresh checkout — silently reverting it. Reconcile all open tabs:
  // close files absent on the target branch, then re-sync the active editor
  // session from disk.
  async _resyncCurrentEditor (rewriteToken) {
    await this.call('fileManager', 'reconcileOpenFilesAfterRewrite', rewriteToken)
  }

  async log (cmd) {
    const status = await git.log({
      ...await this.getGitConfig(),
      ...cmd
    })
    return status
  }

  async branch (cmd) {
    const mutationToken = this._beginGitMutation('updating branches')
    let rewriteToken
    let status
    let operationError = null
    try {
      // Creating and checking out a branch intentionally preserves the current
      // index/worktree, so it does not run the destructive checkout path.
      // It still changes which branch a pending file confirmation would
      // mutate. Briefly fence provider writes: begin/end both invalidate the
      // workspace generation, and the lock closes the gap while HEAD moves.
      if (cmd && cmd.checkout) {
        rewriteToken = await this.call('fileManager', 'beginWorkspaceRewrite', { warningAfterMs: 65000 })
      }
      const { config, gitCmd } = await this._mutationContext(cmd)
      status = await git.branch({ ...config, ...gitCmd })
      await this.call('fileManager', 'refresh')
    } catch (error) {
      operationError = error
    }

    let unlockError = null
    if (rewriteToken !== undefined) {
      try {
        const unlocked = await this.call('fileManager', 'endWorkspaceRewrite', rewriteToken)
        if (unlocked !== true) unlockError = new Error('The editor rejected the Git branch-change token.')
      } catch (error) { unlockError = error }
    }
    // As with checkout/pull, keep the Git mutation lease poisoned if the
    // provider write fence cannot be released safely.
    if (!unlockError) {
      this._endGitMutation(mutationToken)
    }
    if (unlockError) {
      const original = operationError ? `${(operationError && operationError.message) || operationError} ` : ''
      throw new Error(`${original}The branch changed, but the editor safety lock could not be released. Reload TronIDE. Details: ${(unlockError && unlockError.message) || unlockError}`)
    }
    if (operationError) throw operationError
    this._emitGitChanged('branch')
    return status
  }

  async currentbranch () {
    const name = await git.currentBranch({
      ...await this.getGitConfig()
    })
    return name
  }

  async branches (cmd) {
    cmd = cmd || {}
    const branches = await git.listBranches({
      ...await this.getGitConfig(),
      remote: cmd.remote || undefined
    })
    return branches
  }

  async commit (cmd) {
    const mutationToken = this._beginGitMutation('committing changes')
    try {
      const { config, gitCmd } = await this._mutationContext(cmd)
      // Avoid calling the public init() here: commit already owns the mutation
      // lease, and a nested acquisition would either race or deadlock.
      await git.init({ ...config, defaultBranch: 'main' })
      const sha = await git.commit({
        ...config,
        ...gitCmd
      })
      this._emitGitChanged('commit')
      return sha
    } catch (e) {
      console.error('Git commit failed:', e)
      throw e
    } finally {
      this._endGitMutation(mutationToken)
    }
  }

  async lsfiles (cmd) {
    const filesInStaging = await git.listFiles({
      ...await this.getGitConfig(),
      ...cmd
    })
    return filesInStaging
  }

  async resolveref (cmd) {
    const oid = await git.resolveRef({
      ...await this.getGitConfig(),
      ...cmd
    })
    return oid
  }

  async readblob (cmd) {
    const readBlobResult = await git.readBlob({
      ...await this.getGitConfig(),
      ...cmd
    })
    return readBlobResult
  }

  // ---------------------------------------------------------------------------
  // Remote git (GitHub) over smart-HTTP via isomorphic-git + the Deno CORS proxy.
  // These are DISTINCT from the IPFS push/pull above. They run in the browser
  // against the current workspace fs. Network reads stay shallow to keep
  // browser memory bounded while retaining all remote branch refs.
  // ---------------------------------------------------------------------------

  // Clone a remote repo into the current workspace dir. Keep the clone shallow
  // for browser storage, but retain every remote branch ref so the branch
  // picker can discover and check out non-default branches.
  // `cmd`: { url, branch?, depth?, dir?, singleBranch? }
  async clone (cmd) {
    const mutationToken = this._beginGitMutation('cloning the repository')
    try {
      const { config, gitCmd } = await this._mutationContext(cmd || {})
      await git.clone({
        ...config,
        dir: gitCmd.dir || config.dir,
        http,
        corsProxy: GIT_CORS_PROXY,
        url: normalizeGitUrl(gitCmd.url),
        ref: gitCmd.branch || undefined,
        singleBranch: gitCmd.singleBranch === true,
        depth: gitCmd.depth || 1,
        onAuth: gitOnAuth
      })
      await this.call('fileManager', 'refresh')
      this._emitGitChanged('clone')
    } finally {
      this._endGitMutation(mutationToken)
    }
  }

  // Fetch refs/objects from a remote without merging.
  // `cmd`: { url?, remote?, branch?, ref?, singleBranch? }
  async fetchRemote (cmd) {
    const mutationToken = this._beginGitMutation('fetching remote branches')
    try {
      const { config, gitCmd } = await this._mutationContext(cmd || {})
      const singleBranch = gitCmd.singleBranch === true || !!gitCmd.branch
      const result = await git.fetch({
        ...config,
        http,
        corsProxy: GIT_CORS_PROXY,
        url: normalizeGitUrl(gitCmd.url),
        remote: gitCmd.remote || 'origin',
        // isomorphic-git tries to resolve the local HEAD when ref is omitted,
        // which fails for the exact Add-remote-on-an-unborn-repo flow. Remote
        // HEAD is a safe negotiation target while singleBranch=false still
        // downloads and records every advertised branch ref.
        ref: gitCmd.branch || gitCmd.ref || (singleBranch ? undefined : 'HEAD'),
        // Fetch all refs unless a caller explicitly asks for one branch. This is
        // what makes Add remote / Fetch populate the complete branch picker.
        singleBranch,
        depth: gitCmd.depth || 1,
        onAuth: gitOnAuth
      })
      this._emitGitChanged('fetchRemote')
      return result
    } finally {
      this._endGitMutation(mutationToken)
    }
  }

  // Fetch + merge the remote branch into the current branch. `cmd`: { url?, remote?, branch? }
  async pullRemote (cmd) {
    const mutationToken = this._beginGitMutation('pulling remote changes')
    let rewriteToken
    let config
    let localRewriteStarted = false
    let operationError = null
    const rewritePaths = new Set()
    try {
      const mutation = await this._mutationContext(cmd || {})
      config = mutation.config
      const gitCmd = mutation.gitCmd
      const remote = gitCmd.remote || 'origin'
      const startingBranch = await git.currentBranch(config)
      const ref = gitCmd.branch || startingBranch
      if (!ref) throw new Error('Check out a branch before pulling.')

      // isomorphic-git's combined pull performs fetch + merge + checkout
      // without an opportunity to re-check after a long network request. Keep
      // the Git mutation lease during fetch, while normal editor writes remain
      // enabled and are detected by the second clean check below.
      const beforeFetchMatrix = await this._assertCleanWorktree(config, 'pulling')
      beforeFetchMatrix.forEach((row) => rewritePaths.add(row[0]))
      const cache = {}
      const { fetchHead, fetchHeadDescription } = await git.fetch({
        ...config,
        cache,
        http,
        corsProxy: GIT_CORS_PROXY,
        url: normalizeGitUrl(gitCmd.url),
        remote,
        ref,
        singleBranch: true,
        onAuth: gitOnAuth
      })

      // Fetch is intentionally allowed to update remote-tracking refs, just
      // like a normal pull. Workspace/editor changes abort before local merge.
      const activeConfig = await this.getGitConfig()
      if (activeConfig.dir !== config.dir || await git.currentBranch(config) !== startingBranch) {
        throw new Error('Workspace or branch changed while pulling. Remote refs were fetched, but the pull was cancelled.')
      }

      rewriteToken = await this.call('fileManager', 'beginWorkspaceRewrite', { warningAfterMs: 65000 })
      const lockedConfig = await this.getGitConfig()
      if (lockedConfig.dir !== config.dir || await git.currentBranch(config) !== startingBranch) {
        throw new Error('Workspace or branch changed while pulling. Remote refs were fetched, but the pull was cancelled.')
      }
      const beforeRewriteMatrix = await this._assertCleanWorktree(config, 'pulling', rewriteToken)
      beforeRewriteMatrix.forEach((row) => rewritePaths.add(row[0]))

      localRewriteStarted = true
      await git.merge({
        ...config,
        cache,
        ours: ref,
        theirs: fetchHead,
        message: `Merge ${fetchHeadDescription}`,
        // A non-fast-forward pull needs an author for its merge commit.
        author: gitCmd.author || { name: 'TronIDE', email: 'tronide@localhost' }
      })
      await git.checkout({
        ...config,
        cache,
        ref,
        remote
      })
      const afterMatrix = await this._assertRewriteCompleted(config, 'Pull')
      afterMatrix.forEach((row) => rewritePaths.add(row[0]))
    } catch (error) {
      operationError = error
    }

    let reconciliationError = null
    let unlockError = null
    try {
      if (localRewriteStarted && config) {
        try {
          const landedMatrix = await this._verifiedStatusMatrix(config)
          landedMatrix.forEach((row) => rewritePaths.add(row[0]))
        } catch (error) { /* best-effort path hints; editor reconciliation remains mandatory */ }
        try { await this.call('fileManager', 'refresh', [...rewritePaths]) } catch (error) { console.warn('Could not refresh the file explorer after pull:', error) }
        try {
          // Merge/checkout may have failed after a partial worktree update.
          await this._resyncCurrentEditor(rewriteToken)
        } catch (error) {
          reconciliationError = error
        }
      }
      if (rewriteToken !== undefined && !reconciliationError) {
        try {
          const unlocked = await this.call('fileManager', 'endWorkspaceRewrite', rewriteToken)
          if (unlocked !== true) unlockError = new Error('The editor rejected the Git rewrite token.')
        } catch (error) { unlockError = error }
      }
    } finally {
      if (!reconciliationError && !unlockError) this._endGitMutation(mutationToken)
    }

    if (reconciliationError) {
      const original = operationError ? `${(operationError && operationError.message) || operationError} ` : ''
      throw new Error(`${original}The editor could not be reconciled after pull and remains protected. Reload TronIDE before editing. Details: ${(reconciliationError && reconciliationError.message) || reconciliationError}`)
    }
    if (unlockError) {
      const original = operationError ? `${(operationError && operationError.message) || operationError} ` : ''
      throw new Error(`${original}Pull finished, but the editor safety lock could not be released. Reload TronIDE. Details: ${(unlockError && unlockError.message) || unlockError}`)
    }
    if (operationError) throw operationError
    this._emitGitChanged('pullRemote')
  }

  // Push the current/named branch to the remote. `cmd`: { url?, remote?, branch?, force? }
  // A non-fast-forward push surfaces as a rejected push; isomorphic-git's push
  // resolves with { ok:false, error } rather than throwing on some failures, so
  // inspect the result and throw a clear message.
  async pushRemote (cmd) {
    const mutationToken = this._beginGitMutation('pushing remote changes')
    try {
      const { config, gitCmd } = await this._mutationContext(cmd || {})
      const result = await git.push({
        ...config,
        http,
        corsProxy: GIT_CORS_PROXY,
        url: normalizeGitUrl(gitCmd.url),
        remote: gitCmd.remote || 'origin',
        ref: gitCmd.branch || undefined,
        force: !!gitCmd.force,
        onAuth: gitOnAuth
      })
      if (result && result.ok === false) {
        const reason = (result.error) || (result.errors && result.errors.join('; ')) || 'push rejected'
        throw new Error('Push rejected: ' + reason + (gitCmd.force ? '' : ' (try Pull first; remote may be ahead — non-fast-forward)'))
      }
      this._emitGitChanged('pushRemote')
      return result
    } finally {
      this._endGitMutation(mutationToken)
    }
  }

  // Register a named remote. `cmd`: { name, url }
  async addRemote (cmd) {
    const mutationToken = this._beginGitMutation('adding a remote')
    try {
      const { config, gitCmd } = await this._mutationContext(cmd || {})
      await git.addRemote({
        ...config,
        remote: gitCmd.name,
        url: gitCmd.url,
        force: true
      })
      this._emitGitChanged('addRemote')
    } finally {
      this._endGitMutation(mutationToken)
    }
  }

  async listRemotes () {
    return git.listRemotes({
      ...await this.getGitConfig()
    })
  }

  async setIpfsConfig (config) {
    this.ipfsconfig = config
    return this.checkIpfsConfig()
  }

  async checkIpfsConfig (config) {
    this.ipfs = IpfsHttpClient(config || this.ipfsconfig)
    try {
      await this.ipfs.config.getAll()
      return true
    } catch (e) {
      return false
    }
  }

  async push () {
    if (!await this.checkIpfsConfig()) return false
    const workspace = await this.call('filePanel', 'getCurrentWorkspace')
    const files = await this.getDirectory('/')
    this.filesToSend = []
    for (const file of files) {
      const c = window.remixFileSystem.readFileSync(`${workspace.absolutePath}/${file}`)
      const ob = {
        path: file,
        content: c
      }
      this.filesToSend.push(ob)
    }
    const addOptions = {
      wrapWithDirectory: true
    }
    const r = await this.ipfs.add(this.filesToSend, addOptions)
    return r.cid.string
  }

  async pin (pinataApiKey, pinataSecretApiKey) {
    const workspace = await this.call('filePanel', 'getCurrentWorkspace')
    const files = await this.getDirectory('/')
    this.filesToSend = []

    const data = new FormData()
    files.forEach(async (file) => {
      const c = window.remixFileSystem.readFileSync(`${workspace.absolutePath}/${file}`)
      data.append('file', new Blob([c]), `base/${file}`)
    })
    // get last commit data
    let ob
    try {
      const commits = await this.log({ ref: 'HEAD' })
      ob = {
        ref: commits[0].oid,
        message: commits[0].commit.message,
        commits: JSON.stringify(commits.map((commit) => {
          return {
            oid: commit.oid,
            commit: {
              parent: commit.commit?.parent,
              tree: commit.commit?.tree,
              message: commit.commit?.message,
              committer: {
                timestamp: commit.commit?.committer?.timestamp
              }
            }
          }
        }))
      }
    } catch (e) {
      ob = {
        ref: 'no commits',
        message: 'no commits'
      }
    }
    const today = new Date()
    const metadata = JSON.stringify({
      name: `remix - ${workspace.name} - ${today.toLocaleString()}`,
      keyvalues: ob
    })
    const pinataOptions = JSON.stringify({
      wrapWithDirectory: false
    })
    data.append('pinataOptions', pinataOptions)
    data.append('pinataMetadata', metadata)
    const url = 'https://api.pinata.cloud/pinning/pinFileToIPFS'
    try {
      const result = await axios
        .post(url, data, {
          maxBodyLength: 'Infinity',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${data._boundary}`,
            pinata_api_key: pinataApiKey,
            pinata_secret_api_key: pinataSecretApiKey
          }
        })
      return result.data.IpfsHash
    } catch (error) {
      throw new Error('Pinata pin request failed: ' + redactPinataError(error))
    }
  }

  async pinList (pinataApiKey, pinataSecretApiKey) {
    const url = 'https://api.pinata.cloud/data/pinList?status=pinned'
    try {
      const result = await axios
        .get(url, {
          maxBodyLength: 'Infinity',
          headers: {
            pinata_api_key: pinataApiKey,
            pinata_secret_api_key: pinataSecretApiKey
          }
        })
      return result.data
    } catch (error) {
      throw new Error('Pinata pinList request failed: ' + redactPinataError(error))
    }
  }

  async unPin (pinataApiKey, pinataSecretApiKey, hashToUnpin) {
    const url = `https://api.pinata.cloud/pinning/unpin/${hashToUnpin}`
    try {
      await axios
        .delete(url, {
          headers: {
            pinata_api_key: pinataApiKey,
            pinata_secret_api_key: pinataSecretApiKey
          }
        })
      return true
    } catch (error) {
      throw new Error('Pinata unpin request failed: ' + redactPinataError(error))
    }
  };

  async pull (cmd) {
    const mutationToken = this._beginGitMutation('importing files from IPFS')
    try {
      const permission = await this.askUserPermission('pull', 'Import multiple files into your workspaces.')
      console.log(this.ipfsconfig)
      if (!permission) return false
      const cid = cmd.cid
      if (!cmd.local) {
        this.ipfs = IpfsHttpClient(this.globalIPFSConfig)
      } else {
        if (!await this.checkIpfsConfig()) return false
      }
      await this.call('filePanel', 'createWorkspace', `workspace_${Date.now()}`, false)
      const workspace = await this.call('filePanel', 'getCurrentWorkspace')
      for await (const file of this.ipfs.get(cid)) {
        file.path = file.path.replace(cid, '')
        if (!file.content) {
          continue
        }
        const content = []
        for await (const chunk of file.content) {
          content.push(chunk)
        }
        const dir = path.dirname(file.path)
        try {
          this.createDirectories(`${workspace.absolutePath}/${dir}`)
        } catch (e) {
          console.error(`Failed to create directories for ${file.path}:`, e)
        }
        try {
          window.remixFileSystem.writeFileSync(`${workspace.absolutePath}/${file.path}`, Buffer.concat(content) || new Uint8Array())
        } catch (e) {
          console.error(`Failed to write file ${file.path}:`, e)
        }
      }
      this.call('fileManager', 'refresh')
    } finally {
      this._endGitMutation(mutationToken)
    }
  }

  async zip () {
    const zip = new JSZip()
    const workspace = await this.call('filePanel', 'getCurrentWorkspace')
    const files = await this.getDirectory('/')
    this.filesToSend = []
    for (const file of files) {
      const c = window.remixFileSystem.readFileSync(`${workspace.absolutePath}/${file}`)
      zip.file(file, c)
    }
    await zip.generateAsync({
      type: 'blob'
    })
      .then(function (content) {
        saveAs(content, `${workspace.name}.zip`)
      })
  }

  async createDirectories (strdirectories) {
    const ignore = ['.', '/.', '']
    if (ignore.indexOf(strdirectories) > -1) return false
    const directories = strdirectories.split('/')
    for (let i = 0; i < directories.length; i++) {
      let previouspath = ''
      if (i > 0) previouspath = '/' + directories.slice(0, i).join('/')
      const finalPath = previouspath + '/' + directories[i]
      try {
        window.remixFileSystem.mkdirSync(finalPath)
      } catch (e) {
        console.error(`Failed to create directory ${finalPath}:`, e)
      }
    }
  }

  async getDirectory (dir) {
    let result = []
    const files = await this.call('fileManager', 'readdir', dir)
    const fileArray = normalize(files)
    for (const fi of fileArray) {
      if (fi) {
        const type = fi.data.isDirectory
        if (type === true) {
          result = [
            ...result,
            ...(await this.getDirectory(
              `${fi.filename}`
            ))
          ]
        } else {
          result = [...result, fi.filename]
        }
      }
    }
    return result
  }
}

const normalize = (filesList) => {
  const folders = []
  const files = []
  Object.keys(filesList || {}).forEach(key => {
    if (filesList[key].isDirectory) {
      folders.push({
        filename: key,
        data: filesList[key]
      })
    } else {
      files.push({
        filename: key,
        data: filesList[key]
      })
    }
  })
  return [...folders, ...files]
}

module.exports = DGitProvider
