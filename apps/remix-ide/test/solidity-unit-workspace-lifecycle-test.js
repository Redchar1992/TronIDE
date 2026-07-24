/*
 * Copyright © 2026 TronIDE
 * Licensed under the Apache License, Version 2.0.
 */

'use strict'

var Module = require('module')
var test = require('tape')

function loadTestTabWithStubs () {
  var originalLoad = Module._load

  function ViewPlugin (profile) {
    this.profile = profile
  }
  ViewPlugin.prototype.on = function () {}
  ViewPlugin.prototype.off = function () {}

  function TestTabLogic () {
    this.pathUpdates = []
  }
  TestTabLogic.prototype.setCurrentPath = function (path) {
    this.pathUpdates.push(path)
  }

  var stubs = {
    '@remixproject/engine-web': { ViewPlugin: ViewPlugin },
    '../../lib/helper': {
      removeMultipleSlashes: function (value) { return value },
      removeTrailingSlashes: function (value) { return value }
    },
    '@remix-project/remix-solidity': {
      canUseWorker: function () { return true },
      urlFromVersion: function (value) { return value }
    },
    'yo-yo': function () {
      return { value: arguments.length > 1 ? arguments[1] : undefined }
    },
    'async': {},
    '../ui/tooltip': function () {},
    '../ui/renderer': function Renderer () {},
    './styles/test-tab-styles': {},
    '@remix-project/remix-tests': {},
    './testTab/testTab': TestTabLogic
  }

  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request]
    return originalLoad.call(this, request, parent, isMain)
  }

  var babelRegister = require('@babel/register')
  babelRegister({ extensions: ['.js'], cache: false })
  var modulePath = require.resolve('../src/app/tabs/test-tab')
  delete require.cache[modulePath]
  try {
    return require(modulePath)
  } finally {
    Module._load = originalLoad
    babelRegister.revert()
  }
}

test('Solidity Unit Testing serializes a setWorkspace event received before its view exists', async function (t) {
  var TestTab = loadTestTabWithStubs()
  var workspaceHandler
  var preRenderResult
  var fileEvents = {
    on: function () {},
    removeListener: function () {}
  }
  var appManager = {
    event: { on: function () {} }
  }
  var tab = new TestTab(
    { events: fileEvents, currentFile: function () { return '' } },
    {},
    {},
    {},
    appManager,
    {}
  )

  // Reproduce the original lifecycle ordering deterministically: filePanel
  // emits setWorkspace synchronously as soon as listenToEvents subscribes,
  // before render has created inputPath/uiPathList.
  tab.on = function (plugin, event, handler) {
    if (plugin === 'filePanel' && event === 'setWorkspace') {
      workspaceHandler = handler
      preRenderResult = handler()
    }
  }
  tab.onActivationInternal()

  try {
    await preRenderResult
    t.pass('pre-render setWorkspace is queued without touching missing DOM fields')
  } catch (error) {
    t.fail('pre-render setWorkspace rejected: ' + error.message)
  }
  t.equal(tab._workspaceRefreshPending, true, 'the pre-render refresh remains pending')
  t.deepEqual(tab.testTabLogic.pathUpdates, ['tests'], 'backing logic is initialized without touching missing DOM fields')

  var refreshOrder = []
  var injectSecondWorkspaceEvent = true
  tab.inputPath = { value: 'custom-tests' }
  tab.updateDirList = async function () {
    refreshOrder.push('dir')
    if (injectSecondWorkspaceEvent) {
      injectSecondWorkspaceEvent = false
      workspaceHandler()
    }
  }
  tab.updateForNewCurrent = async function () {
    refreshOrder.push('tests')
  }
  tab._viewReady = true

  await tab.requestWorkspaceRefresh()

  t.equal(tab.inputPath.value, 'tests', 'the rendered input resets to the default test path')
  t.deepEqual(tab.testTabLogic.pathUpdates, ['tests', 'tests', 'tests'], 'a second event raised during refresh is drained in a serialized second pass')
  t.deepEqual(refreshOrder, ['dir', 'tests', 'dir', 'tests'], 'directory and test-list refreshes never overlap or reorder')
  t.equal(tab._workspaceRefreshPending, false, 'no workspace refresh is stranded')
  t.equal(tab._workspaceRefreshPromise, null, 'the completed refresh releases its task slot')
  t.end()
})

test('Solidity Unit Testing discards a stale directory list from an older workspace request', async function (t) {
  var TestTab = loadTestTabWithStubs()
  var appManager = { event: { on: function () {} } }
  var tab = new TestTab(
    { events: { on: function () {}, removeListener: function () {} } },
    {},
    {},
    {},
    appManager,
    {}
  )
  var resolveFirst
  var resolveSecond
  tab.testTabLogic = {
    dirList: function (path) {
      return new Promise(function (resolve) {
        if (path === 'workspace-a') resolveFirst = resolve
        else resolveSecond = resolve
      })
    }
  }
  var appended = []
  tab.uiPathList = {
    querySelectorAll: function () { return [] },
    appendChild: function (option) { appended.push(option.value) }
  }

  var first = tab.updateDirList('workspace-a')
  var second = tab.updateDirList('workspace-b')
  resolveSecond(['workspace-b/tests'])
  await second
  resolveFirst(['workspace-a/tests'])
  await first

  t.deepEqual(appended, ['workspace-b/tests'], 'only the newest workspace response populates the datalist')
  t.end()
})

test('Solidity Unit Testing removes the same file handlers that it registered', function (t) {
  var TestTab = loadTestTabWithStubs()
  var registered = []
  var removed = []
  var fileEvents = {
    on: function (event, handler) { registered.push({ event: event, handler: handler }) },
    removeListener: function (event, handler) { removed.push({ event: event, handler: handler }) }
  }
  var tab = new TestTab(
    { events: fileEvents },
    {},
    {},
    {},
    { event: { on: function () {} } },
    {}
  )

  tab.onActivationInternal()
  tab.onDeactivation()

  t.equal(registered.length, 2, 'activation registers both file selection handlers')
  t.equal(removed.length, 2, 'deactivation removes both file selection handlers')
  registered.forEach(function (entry) {
    var match = removed.find(function (candidate) { return candidate.event === entry.event })
    t.ok(match, entry.event + ' is removed')
    t.equal(match && match.handler, entry.handler, entry.event + ' uses the original handler reference')
  })
  t.end()
})
