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
 * Prettier-based source formatting (upstream remix v0.26 parity).
 * Everything is imported lazily so prettier and the solidity plugin land in
 * their own webpack chunk — the main bundle must not grow for a feature that
 * only runs on an explicit user action.
 */

export const FORMATTABLE_EXTENSIONS = ['.sol', '.js', '.ts', '.json']

export function isFormattable (path: string): boolean {
  const lower = (path || '').toLowerCase()
  return FORMATTABLE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * Format `content` according to the file extension of `path`.
 * Throws on syntax errors (callers keep the file untouched in that case).
 */
export async function formatSource (path: string, content: string): Promise<string> {
  const lower = (path || '').toLowerCase()
  const prettier = await import(/* webpackChunkName: "code-formatter" */ 'prettier/standalone')
  if (lower.endsWith('.sol')) {
    const solidity = await import(/* webpackChunkName: "code-formatter" */ 'prettier-plugin-solidity')
    return prettier.format(content, {
      parser: 'solidity-parse',
      plugins: [solidity.default || solidity]
    })
  }
  const babel = await import(/* webpackChunkName: "code-formatter" */ 'prettier/parser-babel')
  return prettier.format(content, {
    // plain 'babel' cannot parse TypeScript-only syntax (enums, `as`,
    // modifiers) — .ts must go through the babel-ts parser the same bundle
    // already provides, or every real .ts file throws on Format.
    parser: lower.endsWith('.json') ? 'json' : (lower.endsWith('.ts') ? 'babel-ts' : 'babel'),
    plugins: [babel.default || babel],
    semi: false,
    singleQuote: true
  })
}
