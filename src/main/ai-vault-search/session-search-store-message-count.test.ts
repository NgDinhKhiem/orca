import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  openSessionSearchIndexFile,
  type SessionSearchIndexFile
} from './session-search-index-test-fixture'
import { SessionSearchStore } from './session-search-store'

const MESSAGE_COUNT_SQL = 'SELECT count(*) AS n FROM messages'

let index: SessionSearchIndexFile
let store: SessionSearchStore

beforeEach(async () => {
  index = await openSessionSearchIndexFile('ss-message-count')
  store = new SessionSearchStore(index.path)
})

afterEach(async () => {
  store.close()
  await index.close()
})

function countScans(): () => number {
  const prepare = vi.spyOn(store.connection, 'prepare')
  return () => prepare.mock.calls.filter(([sql]) => sql === MESSAGE_COUNT_SQL).length
}

it('does not rescan the messages table on every status poll while nothing changes', () => {
  const scans = countScans()
  for (let poll = 0; poll < 10; poll += 1) {
    expect(store.stateCounts().messages).toBe(0)
  }
  expect(scans()).toBe(1)
})

it('recounts after this connection writes messages', () => {
  expect(store.stateCounts().messages).toBe(0)
  store.connection
    .prepare("INSERT INTO messages(session_row_id, role) VALUES (1, 'user'), (1, 'assistant')")
    .run()
  expect(store.stateCounts().messages).toBe(2)
  store.connection.prepare('DELETE FROM messages').run()
  expect(store.stateCounts().messages).toBe(0)
})

it('recounts after another connection commits messages', () => {
  expect(store.stateCounts().messages).toBe(0)
  index.db.prepare("INSERT INTO messages(session_row_id, role) VALUES (1, 'user')").run()
  expect(store.stateCounts().messages).toBe(1)
})
