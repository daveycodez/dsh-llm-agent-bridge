import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')

test('README preserves standalone installation and Relay relationship', () => {
  assert.match(readme, /github:yangbobo2021\/relay-dsh-plugin-claude/)
  assert.match(readme, /@relay\/dsh-plugin-claude/)
  assert.match(readme, /https:\/\/github\.com\/yangbobo2021\/Relay/)
  assert.match(readme, /independently\s+installable/i)
  assert.match(readme, /no runtime dependency on Relay Events or another\s+Relay plugin/i)
})

test('README documents verification and product boundaries', () => {
  assert.match(readme, /DSH_ROOT=\/path\/to\/deepseek-harness npm run verify/)
  assert.match(readme, /Claude account authenticated/)
  assert.match(readme, /does not:[\s\S]*add Wait, Monitor[\s\S]*replace the official DSH layout[\s\S]*install Files or Terminal views/)
})

