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

/**
 * Translate a recorded scenario (the recorder's getAll()/scenario.json shape)
 * into a TronBox project: a migrations script plus the scaffolding files of
 * the official `tronbox init` sample project. Pure string generation — no IDE
 * dependencies — so the translation is unit-testable in isolation.
 */

const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s)

/**
 * Build migrations/2_deploy_contracts.js from a scenario.
 *
 * Each recorded deploy becomes `deployer.deploy(...)` followed by a
 * `.deployed()` capture so later calls target the right instance even when
 * the same contract is deployed more than once. Recorded `created{ts}`
 * tokens (library links and address parameters) resolve to the variable of
 * the matching earlier deploy; anything that cannot be resolved becomes an
 * explicit TODO comment rather than silently dropped.
 *
 * @param {Object} scenario { transactions, abis, accounts, linkReferences }
 * @return {String} the migration source
 */
function scenarioToMigration (scenario) {
  const txs = ((scenario && scenario.transactions) || []).slice().sort((a, b) => a.timestamp - b.timestamp)
  const requires = []
  const requiredSet = new Set()
  const byTimestamp = {}
  const varCount = {}
  const deployedNames = new Set()
  const body = []

  const requireArtifact = (name) => {
    if (!requiredSet.has(name)) {
      requiredSet.add(name)
      requires.push(name)
    }
  }

  const encodeArgs = (parameters) => (parameters || []).map((param) => {
    let encoded = JSON.stringify(param)
    if (encoded === undefined) encoded = 'undefined'
    // created{ts} tokens (also nested inside arrays) -> deployed instance address.
    // An unresolved reference (the deploy it points at was filtered out or
    // failed) must not ship as a bare created{ts} literal — that is not valid
    // code. Mark it explicitly, mirroring the to-target path below.
    return encoded.replace(/"created\{(\d+)\}"/g, (match, stamp) => {
      const dep = byTimestamp[stamp]
      return dep ? `${dep.varName}.address` : `/* TODO: unresolved reference to a deploy not in this flow (${match}) — fill in the address manually. */ undefined`
    })
  })

  const callValueOf = (record) => {
    const value = record.value
    if (value === undefined || value === null) return null
    const asString = String(value)
    return (asString === '0' || asString === '') ? null : asString
  }

  const fromAccounts = new Set(txs.map((tx) => tx.record.from).filter(Boolean))

  for (const tx of txs) {
    const record = tx.record
    if (record.type === 'constructor') {
      const name = record.contractName || 'Contract'
      requireArtifact(name)
      // A reverted step ships as a commented copy of the SAME statements the
      // live path emits ('// ' prefix on one shared template) so the two
      // variants cannot drift, and the fence starts BEFORE the link lines —
      // a live deployer.link() for a fenced deploy would still run on-chain.
      const fence = record.failed ? '// ' : ''
      if (record.failed) {
        body.push(`  // TODO: this recorded deployment of ${name} REVERTED when executed in the IDE — review before migrating:`)
      }
      if (record.linkReferences && Object.keys(record.linkReferences).length) {
        for (const file of Object.keys(record.linkReferences)) {
          for (const lib of Object.keys(record.linkReferences[file])) {
            if (deployedNames.has(lib)) {
              requireArtifact(lib)
              body.push(`  ${fence}await deployer.link(${lib}, ${name});`)
            } else {
              body.push(`  // TODO: ${name} links library ${lib}, which was not deployed in this flow — deploy and link it before this step.`)
            }
          }
        }
      }
      const args = encodeArgs(record.parameters)
      const callValue = callValueOf(record)
      if (callValue) body.push(`  // review: the recorded deployment sent callValue=${callValue} (sun); pass deploy options if your constructor is payable.`)
      body.push(`  ${fence}await deployer.deploy(${[name].concat(args).join(', ')});`)
      if (record.failed) {
        body.push('')
        continue
      }
      varCount[name] = (varCount[name] || 0) + 1
      const varName = `${lowerFirst(name)}${varCount[name] > 1 ? varCount[name] : ''}`
      byTimestamp[tx.timestamp] = { contractName: name, varName }
      deployedNames.add(name)
      body.push(`  const ${varName} = await ${name}.deployed();`)
      body.push('')
    } else {
      const stamp = /created\{(.*)\}/.exec(record.to || '')
      const target = stamp && byTimestamp[stamp[1]]
      if (!target) {
        body.push(`  // TODO: a recorded ${record.type || 'call'}${record.name ? ` to ${record.name}()` : ''} targeted an instance not deployed in this flow — replay it manually.`)
        body.push('')
        continue
      }
      if (record.type !== 'function') {
        body.push(`  // TODO: a recorded ${record.type} transaction to ${target.varName} is not auto-translated — send it manually if needed.`)
        body.push('')
        continue
      }
      const args = encodeArgs(record.parameters)
      const callValue = callValueOf(record)
      const options = callValue ? `${args.length ? ', ' : ''}{ callValue: ${callValue} }` : ''
      // shared template, '// ' fence when the call reverted — a reverted call
      // replayed live would abort the whole migration on-chain
      const fence = record.failed ? '// ' : ''
      if (record.failed) {
        body.push(`  // TODO: this recorded call to ${record.name}() REVERTED when executed in the IDE — review before migrating:`)
      }
      body.push(`  ${fence}await ${target.varName}.${record.name}(${args.join(', ')}${options});`)
      body.push('')
    }
  }

  while (body.length && body[body.length - 1] === '') body.pop()

  const header = ['// Migration generated by TronIDE from a recorded deploy flow.',
    '// Review it, then run: tronbox migrate --network <nile|shasta|mainnet>']
  if (fromAccounts.size > 1) {
    header.push(`// NOTE: the recording used ${fromAccounts.size} different sender accounts; migrations run with the single account configured in tronbox-config.js.`)
  }

  const requireLines = requires.map((name) => `const ${name} = artifacts.require('${name}');`)
  return header.join('\n') + '\n\n' +
    (requireLines.length ? requireLines.join('\n') + '\n\n' : '') +
    'module.exports = async function (deployer) {\n' +
    (body.length ? body.join('\n') + '\n' : '') +
    '};\n'
}

/**
 * tronbox-config.js aligned with the official sample project, with the solc
 * version pinned to what the IDE compiled with.
 */
function tronboxConfig (solcVersion) {
  const version = (typeof solcVersion === 'string' && /\d+\.\d+\.\d+/.exec(solcVersion)) ? /\d+\.\d+\.\d+/.exec(solcVersion)[0] : '0.8.20'
  return `module.exports = {
  networks: {
    mainnet: {
      // Don't put your private key here, see sample-env:
      privateKey: process.env.PRIVATE_KEY_MAINNET,
      userFeePercentage: 100,
      feeLimit: 1000 * 1e6,
      fullHost: 'https://api.trongrid.io',
      network_id: '1'
    },
    shasta: {
      // Obtain test coin at https://shasta.tronex.io/
      privateKey: process.env.PRIVATE_KEY_SHASTA,
      userFeePercentage: 50,
      feeLimit: 1000 * 1e6,
      fullHost: 'https://api.shasta.trongrid.io',
      network_id: '2'
    },
    nile: {
      // Obtain test coin at https://nileex.io/join/getJoinPage
      privateKey: process.env.PRIVATE_KEY_NILE,
      userFeePercentage: 100,
      feeLimit: 1000 * 1e6,
      fullHost: 'https://nile.trongrid.io',
      network_id: '3'
    },
    development: {
      // For the tronbox/tre docker image, see https://hub.docker.com/r/tronbox/tre
      privateKey: '0000000000000000000000000000000000000000000000000000000000000001',
      userFeePercentage: 0,
      feeLimit: 1000 * 1e6,
      fullHost: 'http://127.0.0.1:9090',
      network_id: '9'
    }
  },
  compilers: {
    solc: {
      version: '${version}'
    }
  }
};
`
}

const INITIAL_MIGRATION = `const Migrations = artifacts.require('Migrations.sol');

module.exports = async function (deployer) {
  await deployer.deploy(Migrations);
};
`

const MIGRATIONS_SOL = `// SPDX-License-Identifier: MIT
pragma solidity >=0.4.22 <0.9.0;

contract Migrations {
  address public owner = msg.sender;
  uint public last_completed_migration;

  modifier restricted() {
    require(msg.sender == owner, "This function is restricted to the contract's owner");
    _;
  }

  function setCompleted(uint completed) public restricted {
    last_completed_migration = completed;
  }
}
`

const SAMPLE_ENV = `export PRIVATE_KEY_MAINNET=
export PRIVATE_KEY_SHASTA=
export PRIVATE_KEY_NILE=
`

const README = `# TronBox project exported from TronIDE

This project was generated from a deploy flow recorded in TronIDE
(Deploy & Run > Transactions recorded > Export to TronBox).

## Layout

- \`contracts/\` — the Solidity sources of your TronIDE workspace (plus TronBox's \`Migrations.sol\`)
- \`migrations/2_deploy_contracts.js\` — your recorded deploy flow, translated to a TronBox migration
- \`tronbox-config.js\` — Mainnet / Shasta / Nile / local network templates

## Usage

\`\`\`shell
npm install -g tronbox
tronbox compile
\`\`\`

Put your private key in a gitignored \`.env\` file (see \`sample-env\`), then:

\`\`\`shell
source .env && tronbox migrate --network nile
\`\`\`

(Use \`--network shasta\` or \`--network mainnet\` accordingly.)

## Notes

- Review \`migrations/2_deploy_contracts.js\` before migrating: steps the
  exporter could not translate are marked with TODO comments.
- Sources imported from outside the workspace (e.g. GitHub/.deps imports)
  are not bundled; install or copy them before compiling.
`

module.exports = { scenarioToMigration, tronboxConfig, INITIAL_MIGRATION, MIGRATIONS_SOL, SAMPLE_ENV, README }
