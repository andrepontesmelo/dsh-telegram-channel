import assert from 'node:assert/strict'
import test from 'node:test'
import { MSG, parseCommand } from '../src/commands.ts'

test('parse slash commands for remote control', () => {
  assert.equal(parseCommand('/start').type, 'start')
  assert.equal(parseCommand('/help').type, 'help')
  assert.equal(parseCommand('/sessions').type, 'sessions')
  assert.equal(parseCommand('/list').type, 'sessions')
  assert.equal(parseCommand('/status').type, 'status')
  assert.equal(parseCommand('/unbind').type, 'unbind')
  assert.equal(parseCommand('/disconnect').type, 'unbind')
  assert.equal(parseCommand('/model').type, 'model')
  assert.equal(parseCommand('/last').type, 'last')
  assert.equal(parseCommand('/context').type, 'last')
  assert.equal(parseCommand('/sessions@MyBot').type, 'sessions')
  assert.equal(parseCommand('/foo').type, 'unknown')
  assert.equal(parseCommand('hello').type, 'plain')
})

test('English copy mentions sessions and bind', () => {
  assert.ok(MSG.DENIED.includes('Access denied'))
  assert.ok(MSG.HELP.includes('/sessions'))
  assert.ok(MSG.HELP.includes('/last'))
  assert.ok(MSG.HELP.includes('/model'))
  assert.ok(MSG.NEED_BIND.includes('/sessions'))
  assert.ok(MSG.WELCOME.includes('Web') || MSG.WELCOME.includes('remote'))
})
