/*
 * Copyright 2026 [TronIDE]
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

import * as packageJson from '../../../../../../package.json'
import { ViewPlugin } from '@remixproject/engine-web'

const yo = require('yo-yo')
const csjs = require('csjs-inject')

const css = csjs`
  .container {
    height: 100%;
    overflow-y: auto;
    padding: 32px 48px 64px;
    line-height: 1.55;
  }
  .inner {
    max-width: 860px;
    margin: 0 auto;
  }
  .pageTitle {
    font-size: 1.6rem;
    font-weight: 700;
    margin-bottom: 4px;
  }
  .pageSub {
    opacity: .7;
    margin-bottom: 28px;
  }
  .release {
    border: 1px solid var(--secondary, rgba(128,128,128,.25));
    border-radius: 10px;
    padding: 20px 24px;
    margin-bottom: 24px;
  }
  .releaseHead {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 6px;
  }
  .releaseVersion {
    font-size: 1.25rem;
    font-weight: 700;
  }
  .releaseDate {
    opacity: .6;
    font-size: .85rem;
  }
  .releaseTag {
    font-size: .7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .04em;
    padding: 2px 8px;
    border-radius: 10px;
    border: 1px solid currentColor;
    opacity: .8;
  }
  .areaTitle {
    font-size: .95rem;
    font-weight: 700;
    margin: 14px 0 4px;
  }
  .areaList {
    margin: 0;
    padding-left: 20px;
  }
  .areaList li {
    margin: 3px 0;
  }
  .footer {
    opacity: .7;
    font-size: .9rem;
    margin-top: 8px;
  }
  .footer a {
    text-decoration: underline;
  }
`

// One entry per release, newest first. Keep the copy user-facing: what changed
// and why it matters, not commit prose.
const RELEASES = [
  {
    version: '2.3.2',
    date: 'July 2026',
    tag: 'Current',
    areas: [
      {
        title: 'Git & GitHub',
        items: [
          'Full local Git panel for every workspace: init, stage / unstage, commit, history, and branches — with a guard before switching away from uncommitted changes.',
          'Clone GitHub repositories into a fresh workspace, then fetch, pull, push and force-push — all in the browser, routed through a hardened proxy.',
          'Connect GitHub with an OAuth popup instead of pasting a personal access token; once connected, the header button opens an account menu.',
          'GitHub connections survive a refresh in the same browser tab; closing the tab or choosing Disconnect forgets the token.',
          'The Settings-tab gist token is retired: gist import and publish now use the connected GitHub account, and any token saved there by an older version is scrubbed at startup.'
        ]
      },
      {
        title: 'AI Assistant',
        items: [
          'The assistant gained a real tool belt: compile and set the compiler version, deploy, read and write contracts, run tests and static analysis, save a compiler-settings reference for manual TronScan verification, and manage files, workspaces and local git (including clone, push and pull).',
          'It can also search the workspace by content, show a diff of your changes, make precise in-place edits, and turn a recorded deploy flow into a runnable TronBox project — record, replay and export.',
          'Esc interrupts a running request, ArrowUp / ArrowDown recalls previous questions, and failed requests render a visible error instead of hanging.',
          'Plain-HTTP AI endpoints are rejected so API keys and prompts never travel in cleartext.'
        ]
      },
      {
        title: 'Compiler',
        items: [
          'When a compiler binary cannot be downloaded, the IDE falls back to the bundled 0.8.20 compiler and shows a clear banner about it.',
          'Version switches are more reliable on slow networks (load timeout raised to 120 s) and stale error annotations are cleared on every compile.'
        ]
      },
      {
        title: 'Contract Verification',
        items: [
          'Choose the actual deployable main contract instead of an imported interface, then download a flattened .sol file that TronScan accepts under Contract File(s).',
          'Verification metadata is clearly labeled as a reference checklist because TronScan does not accept the exported JSON as a contract upload.'
        ]
      },
      {
        title: 'Editor & Workspace',
        items: [
          'Custom right-click menu in the editor so Copy / Cut / Paste work in every browser, with keyboard access.',
          'Syntax highlighting for HTML, CSS, Markdown and TypeScript files.',
          'The IDE restores your last-used workspace at boot, and a failed clone can no longer hijack the restore target.'
        ]
      },
      {
        title: 'Analysis & Recorder',
        items: [
          'Static analysis: category summary bar, advisory findings collapsed by default and excluded from the sidebar badge, imported libraries recognized across URL and .deps import styles.',
          'Recorder: reverted executions are stamped on both the VM and injected paths, and the TronBox export fences them as TODO steps.'
        ]
      },
      {
        title: 'Help & Feedback',
        items: [
          'Open these Release Notes any time from the version badge in the header, or the "Release Notes" link on the Home page.',
          'Hit a bug or have a suggestion? The "Report an issue" link on the Home page and at the bottom of this page opens the project\'s GitHub issues.'
        ]
      }
    ]
  },
  {
    version: '2.3.1',
    date: 'June 2026',
    tag: '',
    areas: [
      {
        title: 'Deploy Recorder',
        items: [
          'Deployed-contracts address book on the recorder card, with per-step deploy status and fail-stop highlighting.',
          'Export a recorded deploy flow as a ready-to-run TronBox project, pinned to the solc version that actually compiled it.'
        ]
      },
      {
        title: 'Compiler & Workspace',
        items: [
          'Recommended TVM compiler quick-picks (legacy 0.4.x builds removed from the recommendations).',
          'Template picker when creating a workspace, with a confirmation before a template overwrites user edits.',
          'Format code with Prettier from the file-explorer menu.'
        ]
      },
      {
        title: 'Contract Verification',
        items: [
          'Flatten sources directly in the Contract Verification panel.'
        ]
      }
    ]
  },
  {
    version: '2.3.0',
    date: 'June 2026',
    tag: '',
    areas: [
      {
        title: 'Home & Navigation',
        items: [
          'Redesigned Home: quick-start cards, most-used plugins with one-click activation, and a collapsible advanced-tools area.',
          'New top bar with a workspace menu (create / backup / restore / connect to localhost), Connect GitHub and Connect Wallet.'
        ]
      },
      {
        title: 'TronLink Wallet (new)',
        items: [
          'First-class TronLink connection: deploy and transact on Nile or Mainnet, with clear feedback when the wallet is rejected, locked or unresponsive.',
          'The IDE follows account and network switches, blocks cross-network transactions, and a dead wallet bridge can no longer hang a transaction at "pending".'
        ]
      },
      {
        title: 'Contract Verification (new)',
        items: [
          'TronScan-first verification plugin: check a deployed address, preserve the latest compilation metadata, and submit the matching Solidity source manually on TronScan.'
        ]
      },
      {
        title: 'AI Assistant',
        items: [
          'Model lineup expanded across five vendors — Anthropic, OpenAI, Google, xAI and Qwen — including GPT-5.5, Claude Opus 4.8, Gemini 3.0 Pro and Qwen 3.7.',
          'API keys stay in browser memory only and are never uploaded or stored.'
        ]
      },
      {
        title: 'Build, Debug & Analysis',
        items: [
          'One-click compile of the current file from the editor tab bar.',
          'The debugger works on the TVM engine: instruction stepping (including TRON-specific opcodes), Solidity locals, state and the call stack.',
          'Static analysis gained a TRON category with transaction-config checks such as feeLimit and callValue.'
        ]
      },
      {
        title: 'Security & Reliability',
        items: [
          'Security headers (CSP, anti-clickjacking), strict plugin-URL validation and dependency CVE fixes.',
          'Workspace search / replace with one-click undo, hardened GitHub token and Gist workflows, and dozens of stability fixes.'
        ]
      }
    ]
  }
]

const profile = {
  name: 'releaseNotes',
  displayName: 'Release Notes',
  methods: [],
  events: [],
  description: 'What changed in each TRON IDE release',
  icon: 'assets/img/tron-ide.svg',
  location: 'mainPanel',
  version: packageJson.version
}

export class ReleaseNotes extends ViewPlugin {
  constructor () {
    super(profile)
    this.profile = profile
    this.el = null
  }

  renderRelease (release) {
    const versionId = release.version.replace(/\./g, '')
    return yo`
      <section class=${css.release} data-id="releaseNotesV${versionId}">
        <div class=${css.releaseHead}>
          <span class=${css.releaseVersion}>v${release.version}</span>
          <span class=${css.releaseDate}>${release.date}</span>
          ${release.tag ? yo`<span class=${css.releaseTag}>${release.tag}</span>` : ''}
        </div>
        ${release.areas.map(area => yo`
          <div>
            <div class=${css.areaTitle}>${area.title}</div>
            <ul class=${css.areaList}>
              ${area.items.map(item => yo`<li>${item}</li>`)}
            </ul>
          </div>
        `)}
      </section>
    `
  }

  render () {
    if (this.el) return this.el
    this.el = yo`
      <div class=${css.container} data-id="releaseNotesView">
        <div class=${css.inner}>
          <div class=${css.pageTitle}>Release Notes</div>
          <div class=${css.pageSub}>You are running TRON IDE v${packageJson.version}.</div>
          ${RELEASES.map(release => this.renderRelease(release))}
          <div class=${css.footer}>
            Found a bug or have a suggestion?
            <a href="https://github.com/tronweb3/TronIDE/issues" target="_blank" rel="noopener noreferrer" data-id="releaseNotesReportIssue">Open an issue on GitHub</a>.
            For the complete change history, see the
            <a href="https://github.com/tronweb3/TronIDE" target="_blank" rel="noopener noreferrer">project repository</a>.
          </div>
        </div>
      </div>
    `
    return this.el
  }
}
