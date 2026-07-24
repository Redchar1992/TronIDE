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
 * Generate a Mermaid `classDiagram` from Solidity source, browser-native via
 * @solidity-parser/parser (already bundled). This is the lightweight TronIDE
 * approach to contract visualization — it does NOT pull in `sol2uml` + graphviz
 * (heavy wasm) the way upstream Remix's UML generator does. Chain-agnostic, so
 * it works for TVM Solidity unchanged.
 *
 * Output is Mermaid text (caller renders it lazily). Pure + dependency-light, so
 * it is unit-testable directly in Node.
 */

const parser = require('@solidity-parser/parser')

// Mermaid is strict about characters in member lines: parentheses are fine (the
// method syntax), but `<`, `>`, `=>`, quotes etc. break parsing. Keep type/name
// rendering to a safe, simple subset.
function sanitize (s) {
  return String(s == null ? '' : s).replace(/[^A-Za-z0-9_$.[\]() ,]/g, '')
}

function typeToString (t) {
  if (!t) return 'var'
  switch (t.type) {
    case 'ElementaryTypeName': return t.name || 'var'
    case 'UserDefinedTypeName': return t.namePath || 'var'
    case 'ArrayTypeName': return typeToString(t.baseTypeName) + '[]'
    case 'Mapping': return 'mapping' // `mapping(a=>b)` would break mermaid
    case 'FunctionTypeName': return 'function'
    default: return 'var'
  }
}

// public/external -> + ; internal -> # ; private -> - ; default -> + (fn) / # (state)
function visSymbol (visibility, kind) {
  switch (visibility) {
    case 'public':
    case 'external': return '+'
    case 'private': return '-'
    case 'internal': return '#'
    default: return kind === 'state' ? '#' : '+'
  }
}

function stereotype (node) {
  if (node.kind === 'interface') return '<<interface>>'
  if (node.kind === 'library') return '<<library>>'
  if (node.kind === 'abstract' || node.isAbstract) return '<<abstract>>'
  return ''
}

/**
 * @param {string} source Solidity source (may contain multiple contracts)
 * @returns {string} Mermaid classDiagram text (starts with "classDiagram")
 */
function solToMermaid (source) {
  const lines = ['classDiagram']
  if (!source || !source.trim()) return lines.join('\n')

  let ast
  try {
    ast = parser.parse(source, { tolerant: true })
  } catch (e) {
    return lines.join('\n') // syntax errors are the compiler's job; show nothing
  }

  const edges = []
  const defined = new Set()

  parser.visit(ast, {
    ContractDefinition (node) {
      const name = sanitize(node.name)
      if (!name) return
      defined.add(name)
      const members = []
      const st = stereotype(node)
      if (st) members.push('    ' + st)

      for (const sub of node.subNodes || []) {
        if (sub.type === 'StateVariableDeclaration') {
          for (const v of sub.variables || []) {
            members.push(`    ${visSymbol(v.visibility, 'state')}${sanitize(typeToString(v.typeName))} ${sanitize(v.name)}`)
          }
        } else if (sub.type === 'FunctionDefinition') {
          let fname = sub.name
          if (sub.isConstructor) fname = 'constructor'
          else if (sub.isFallback) fname = 'fallback'
          else if (sub.isReceiveEther) fname = 'receive'
          fname = sanitize(fname) || 'fn'
          const params = (sub.parameters || []).map((p) => sanitize(typeToString(p.typeName))).join(', ')
          const rets = (sub.returnParameters || []).map((p) => sanitize(typeToString(p.typeName))).join(', ')
          const retStr = rets ? ' ' + rets : ''
          members.push(`    ${visSymbol(sub.visibility, 'fn')}${fname}(${params})${retStr}`)
        }
      }

      lines.push(`class ${name} {`)
      lines.push(...members)
      lines.push('}')

      // inheritance edges: Base <|-- Derived
      for (const base of node.baseContracts || []) {
        const bn = sanitize(base.baseName && base.baseName.namePath)
        if (bn) edges.push(`${bn} <|-- ${name}`)
      }
    }
  })

  // de-dupe edges, keep stable order
  const seen = new Set()
  for (const e of edges) { if (!seen.has(e)) { seen.add(e); lines.push(e) } }

  return lines.join('\n')
}

// sanitize is exported for the unit tests only: parseable Solidity identifiers
// can never carry unsafe characters, so the strip behavior is not reachable
// through solToMermaid with well-formed input — it guards parser-recovered
// (tolerant-mode) fragments and must stay pinned directly.
module.exports = { solToMermaid, sanitize }
