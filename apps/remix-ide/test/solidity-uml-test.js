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

/*
 * Pure parser tests for solToMermaid(). The Playwright suite covers render +
 * inheritance + the no-contract path in the browser; these pin the text output
 * for the edge cases that are awkward to assert through Mermaid — interface /
 * library / abstract stereotypes, mapping-type collapsing, syntax-error
 * tolerance, and identifier sanitization (the XSS-relevant bit).
 */

'use strict'

var test = require('tape')
var { solToMermaid, sanitize } = require('../src/app/tabs/solidity-uml')

test('solToMermaid: empty / whitespace source -> bare header', function (t) {
  t.equal(solToMermaid(''), 'classDiagram')
  t.equal(solToMermaid('   \n  '), 'classDiagram')
  t.equal(solToMermaid(undefined), 'classDiagram')
  t.end()
})

test('solToMermaid: syntax error is tolerated, never throws', function (t) {
  var out
  t.doesNotThrow(function () { out = solToMermaid('contract Broken { uint x = ; func(') })
  // tolerant parse may still recover the class; the contract must be that the
  // call returns a string starting with the header rather than throwing.
  t.equal(out.split('\n')[0], 'classDiagram')
  t.end()
})

test('solToMermaid: contract with state vars + function, visibility symbols', function (t) {
  var out = solToMermaid(
    'pragma solidity ^0.8.0;\n' +
    'contract Token {\n' +
    '  uint256 public total;\n' +
    '  address private owner;\n' +
    '  function transfer(address to, uint256 amt) public returns (bool) {}\n' +
    '  function _burn(uint256 amt) internal {}\n' +
    '}'
  )
  t.ok(out.indexOf('class Token {') !== -1, 'class block present')
  t.ok(out.indexOf('+uint256 total') !== -1, 'public state -> +')
  t.ok(out.indexOf('-address owner') !== -1, 'private state -> -')
  t.ok(out.indexOf('+transfer(address, uint256) bool') !== -1, 'public fn -> + with return')
  t.ok(out.indexOf('#_burn(uint256)') !== -1, 'internal fn -> #')
  t.end()
})

test('solToMermaid: interface / library / abstract stereotypes', function (t) {
  t.ok(solToMermaid('interface IFoo { function f() external; }').indexOf('<<interface>>') !== -1)
  t.ok(solToMermaid('library L { function f() internal {} }').indexOf('<<library>>') !== -1)
  t.ok(solToMermaid('abstract contract A { function f() public virtual; }').indexOf('<<abstract>>') !== -1)
  t.end()
})

test('solToMermaid: mapping type collapses to "mapping" (would break mermaid)', function (t) {
  var out = solToMermaid('contract M { mapping(address => uint256) public balances; }')
  t.ok(out.indexOf('mapping balances') !== -1, 'mapping rendered as bare keyword')
  t.equal(out.indexOf('=>'), -1, 'no arrow leaks into output')
  t.end()
})

test('solToMermaid: array type renders []', function (t) {
  var out = solToMermaid('contract Arr { address[] public holders; }')
  t.ok(out.indexOf('address[] holders') !== -1)
  t.end()
})

test('solToMermaid: special functions named', function (t) {
  var out = solToMermaid(
    'contract C {\n' +
    '  constructor() public {}\n' +
    '  fallback() external {}\n' +
    '  receive() external payable {}\n' +
    '}'
  )
  t.ok(out.indexOf('constructor()') !== -1)
  t.ok(out.indexOf('fallback()') !== -1)
  t.ok(out.indexOf('receive()') !== -1)
  t.end()
})

test('solToMermaid: inheritance edge, de-duped and stable', function (t) {
  var out = solToMermaid(
    'contract Base {}\n' +
    'contract A is Base {}\n' +
    'contract B is Base {}'
  )
  t.ok(out.indexOf('Base <|-- A') !== -1)
  t.ok(out.indexOf('Base <|-- B') !== -1)
  t.end()
})

test('solToMermaid: identifier sanitization strips unsafe chars', function (t) {
  // `contract Ev<il"x` does NOT parse (even tolerant mode drops it), so asserting
  // payload ABSENCE on solToMermaid output was vacuous — the bare 'classDiagram'
  // header contains no payload whether or not sanitize() runs. Pin the strip
  // behavior on sanitize() directly (it guards parser-recovered fragments)…
  t.equal(sanitize('Ev<il"x'), 'Evilx', 'mermaid/HTML-breaking characters are stripped')
  t.equal(sanitize('a=>b;{}'), 'ab', 'arrow/brace/semicolon payloads are stripped')
  t.equal(sanitize('safe_Name$1[](), .'), 'safe_Name$1[](), .', 'the documented safe subset passes through untouched')
  t.equal(sanitize(null), '', 'nullish input collapses to an empty string')
  // …and pin PRESENCE through the real pipeline: a parseable contract renders
  // its sanitized members, and the mapping type collapses to the safe literal
  // (never `mapping(a=>b)`, which would break mermaid).
  var out = solToMermaid('contract Safe { uint256[] public xs; mapping(address => uint256) public m; }')
  t.ok(out.indexOf('class Safe') !== -1, 'parseable contract renders its class (non-vacuous)')
  t.ok(out.indexOf('uint256[] xs') !== -1, 'safe array type reaches the member line intact')
  t.ok(out.indexOf('mapping m') !== -1, 'mapping member renders via the safe literal')
  t.equal(out.indexOf('=>'), -1, 'no mermaid-breaking arrow in the diagram text')
  t.end()
})

test('solToMermaid: source with no contract -> bare header (no class)', function (t) {
  var out = solToMermaid('pragma solidity ^0.8.0;\n// just a comment')
  t.equal(out.indexOf('class '), -1, 'no class block')
  t.equal(out.split('\n')[0], 'classDiagram')
  t.end()
})
