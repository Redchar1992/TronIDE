/*
 * Copyright © 2026 TronIDE
 * Licensed under the Apache License, Version 2.0.
 */

'use strict'

function decodeBase64Utf8 (payload) {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new Error('The encoded Base64 payload is empty.')
  }

  let raw
  try {
    raw = atob(payload)
  } catch (error) {
    throw new Error('The payload is not valid Base64.')
  }

  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function encodeBase64Utf8 (value) {
  if (typeof value !== 'string') throw new Error('Only text can be encoded as Base64.')

  const bytes = new TextEncoder().encode(value)
  const chunks = []
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize)))
  }
  return btoa(chunks.join(''))
}

/**
 * Decode UTF-8 text transported as a (possibly percent-encoded) Base64 URL
 * parameter. Hash parameters stay raw in QueryParams so each consumer can
 * decode exactly once without corrupting encoded separators such as `%26`.
 *
 * @param {string} payload Base64 text from a URL parameter
 * @returns {string} decoded UTF-8 text
 */
function decodeUrlBase64 (payload) {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new Error('The encoded URL payload is empty.')
  }

  let encoded
  try {
    encoded = decodeURIComponent(payload)
  } catch (error) {
    throw new Error('The URL payload contains invalid percent encoding.')
  }

  try {
    return decodeBase64Utf8(encoded)
  } catch (error) {
    throw new Error('The URL payload is not valid Base64.')
  }
}

module.exports = { decodeBase64Utf8, decodeUrlBase64, encodeBase64Utf8 }
