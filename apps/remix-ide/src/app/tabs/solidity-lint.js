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
 * A focused, in-editor Solidity linter built on @solidity-parser/parser
 * (browser-safe, already bundled via prettier-plugin-solidity). This is NOT
 * the full Node `solhint` package (which doesn't bundle for the browser) — it
 * implements a focused, low-false-positive subset of high-value rules and
 * surfaces them as live editor annotations. Rules: spdx, pragma, func-visibility,
 * state-visibility, avoid-tx-origin, no-selfdestruct, avoid-throw, avoid-sha3,
 * reason-string, contract-name-capwords (the last four mirror Solhint's, added
 * in lieu of integrating the non-browser-bundlable solhint package).
 *
 * The parser is require()'d statically here, but this whole module is itself
 * dynamically imported by the editor (webpackChunkName "solidity-lint"), so
 * parser + rules land in one lazy chunk and never weigh on the main bundle.
 * (A direct dynamic import() of the parser's CJS build trips a webpack
 * interop bug — "__webpack_require__(...).join is not a function".)
 *
 * Each finding: { line, column, severity: 'warning'|'info', message, rule }.
 * Lines/columns are 1-based (parser loc); the caller maps to 0-based editor rows.
 */

const parser = require('@solidity-parser/parser')

// Heuristic check for a banned global member access (e.g. tx.origin).
function findMemberUsage (node, object, property) {
  return node && node.type === 'MemberAccess' &&
    node.expression && node.expression.type === 'Identifier' &&
    node.expression.name === object && node.memberName === property
}

function lintSolidity (source) {
  const findings = []
  if (!source || !source.trim()) return findings

  // file-level rules don't need the AST
  if (!/SPDX-License-Identifier:/.test(source)) {
    findings.push({ line: 1, column: 1, severity: 'warning', rule: 'spdx', message: 'Missing SPDX license identifier. Add a "// SPDX-License-Identifier: <id>" comment.' })
  }
  if (!/^\s*pragma\s+solidity\b/m.test(source)) {
    findings.push({ line: 1, column: 1, severity: 'warning', rule: 'pragma', message: 'Missing "pragma solidity" version statement.' })
  }

  let ast
  try {
    ast = parser.parse(source, { loc: true, tolerant: true })
  } catch (e) {
    // a syntax error is the compiler's job to report; lint stays silent
    return findings
  }

  const at = (node) => (node && node.loc ? { line: node.loc.start.line, column: node.loc.start.column + 1 } : { line: 1, column: 1 })

  // FILE-LEVEL (free) functions cannot carry a visibility at all — flagging
  // them with func-visibility is a false positive (adding one is a compile
  // error). Collect the SourceUnit's direct function children and exempt them.
  const freeFunctions = new Set()
  for (const child of (ast.children || [])) {
    if (child && child.type === 'FunctionDefinition') freeFunctions.add(child)
  }

  parser.visit(ast, {
    ContractDefinition (node) {
      // Solhint `contract-name-capwords`: contracts/interfaces/libraries CapWords.
      if (node.name && !/^[A-Z]/.test(node.name)) {
        findings.push({ ...at(node), severity: 'info', rule: 'contract-name-capwords', message: `${node.kind || 'contract'} "${node.name}" should be in CapWords (start with an uppercase letter).` })
      }
    },
    ThrowStatement (node) {
      // Solhint `avoid-throw`: throw was removed in 0.5+.
      findings.push({ ...at(node), severity: 'warning', rule: 'avoid-throw', message: '"throw" is deprecated and removed in Solidity 0.5+; use revert()/require() with a reason.' })
    },
    FunctionDefinition (node) {
      // constructors/modifiers/fallback/receive have their own visibility rules
      if (node.isConstructor || node.isFallback || node.isReceiveEther) return
      if (freeFunctions.has(node)) return
      if (!node.visibility || node.visibility === 'default') {
        findings.push({ ...at(node), severity: 'warning', rule: 'func-visibility', message: `Function "${node.name || '<unnamed>'}" is missing an explicit visibility (public/external/internal/private).` })
      }
    },
    StateVariableDeclaration (node) {
      for (const v of node.variables || []) {
        if (!v.visibility || v.visibility === 'default') {
          findings.push({ ...at(v), severity: 'info', rule: 'state-visibility', message: `State variable "${v.name}" has no explicit visibility; it defaults to internal.` })
        }
      }
    },
    MemberAccess (node) {
      if (findMemberUsage(node, 'tx', 'origin')) {
        findings.push({ ...at(node), severity: 'warning', rule: 'avoid-tx-origin', message: 'Avoid tx.origin for authorization; it is unsafe against phishing. Use msg.sender.' })
      }
    },
    FunctionCall (node) {
      const callee = node.expression
      if (!callee || callee.type !== 'Identifier') return
      if (callee.name === 'selfdestruct' || callee.name === 'suicide') {
        findings.push({ ...at(node), severity: 'warning', rule: 'no-selfdestruct', message: `"${callee.name}" is deprecated and removed/altered on modern chains; avoid relying on it.` })
      } else if (callee.name === 'sha3') {
        // Solhint `avoid-sha3`: sha3 is a deprecated alias for keccak256.
        findings.push({ ...at(node), severity: 'warning', rule: 'avoid-sha3', message: '"sha3" is deprecated; use keccak256 instead.' })
      } else if (callee.name === 'require' && (node.arguments || []).length < 2) {
        // Solhint `reason-string`: a require without a message gives no error context.
        findings.push({ ...at(node), severity: 'info', rule: 'reason-string', message: 'require() has no reason string; add a message so the failure is explained.' })
      }
    }
  })

  // stable order: by line then column
  findings.sort((a, b) => a.line - b.line || a.column - b.column)
  return findings
}

module.exports = { lintSolidity }
