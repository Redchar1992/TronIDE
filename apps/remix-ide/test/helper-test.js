/*
 * Copyright © 2026 TronIDE
 * Licensed under the Apache License, Version 2.0.
 */

'use strict'

var test = require('tape')
var helper = require('../src/lib/helper')

test('createNonClashingNameWithPrefix awaits provider checks and returns the first free name', function (t) {
  var checked = []
  var occupied = new Set([
    'tests/simple_storage_test.sol',
    'tests/simple_storage1_test.sol'
  ])
  var provider = {
    exists: async function (path) {
      checked.push(path)
      return occupied.has(path)
    }
  }

  helper.createNonClashingNameWithPrefix('tests/simple_storage.sol', provider, '_test', function (error, name) {
    t.error(error, 'name lookup completes without error')
    t.equal(name, 'tests/simple_storage2_test.sol', 'the first unoccupied suffix is returned')
    t.deepEqual(checked, [
      'tests/simple_storage_test.sol',
      'tests/simple_storage1_test.sol',
      'tests/simple_storage2_test.sol'
    ], 'each collision is awaited in order')
    t.end()
  })
})

test('createNonClashingNameWithPrefix reports provider failures instead of hanging', function (t) {
  var expected = new Error('filesystem unavailable')
  var provider = {
    exists: async function () {
      throw expected
    }
  }

  helper.createNonClashingNameWithPrefix('tests/simple_storage.sol', provider, '_test', function (error, name) {
    t.equal(error, expected, 'provider failure reaches the callback')
    t.equal(name, 'tests/simple_storage_test.sol', 'the failed candidate is included for diagnostics')
    t.end()
  })
})
