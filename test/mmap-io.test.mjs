import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mmap = require('../mmap-io.js')

const CONSTANTS = [
  'PROT_READ',
  'PROT_WRITE',
  'PROT_EXEC',
  'PROT_NONE',
  'MAP_SHARED',
  'MAP_PRIVATE',
  'MADV_NORMAL',
  'MADV_RANDOM',
  'MADV_SEQUENTIAL',
  'MADV_WILLNEED',
  'MADV_DONTNEED',
  'PAGESIZE'
]

/**
 * Creates a zero-filled scratch file and returns a writable fd for it.
 * The fd is closed when the test process exits.
 */
function openScratch(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmap-io-'))
  const file = path.join(dir, 'data.bin')
  fs.writeFileSync(file, Buffer.alloc(bytes))
  const fd = fs.openSync(file, 'r+')
  return { file, fd }
}

/**
 * map() hands back a SharedArrayBuffer; every other entry point wants an
 * ArrayBufferView over it. Wrapping here keeps that in one place.
 */
function mapFile(fd, size, prot = mmap.PROT_READ | mmap.PROT_WRITE) {
  const sab = mmap.map(size, prot, mmap.MAP_SHARED, fd)
  return { sab, buf: Buffer.from(sab) }
}

test('exports every documented constant as a number', () => {
  for (const key of CONSTANTS) {
    assert.equal(typeof mmap[key], 'number', `${key} should be a number`)
  }
  assert.ok(mmap.PAGESIZE > 0, 'PAGESIZE should be positive')
})

test('hides the private sync implementation', () => {
  assert.equal(mmap.sync_lib_private__, undefined)
  assert.equal(typeof mmap.sync, 'function')
})

test('map() returns a SharedArrayBuffer of the requested size', () => {
  const size = mmap.PAGESIZE * 2
  const { fd } = openScratch(size)
  try {
    const { sab } = mapFile(fd, size)
    assert.ok(sab instanceof SharedArrayBuffer, 'map() should return a SharedArrayBuffer')
    assert.equal(sab.byteLength, size)
  } finally {
    fs.closeSync(fd)
  }
})

test('map() rejects malformed arguments', () => {
  const { fd } = openScratch(mmap.PAGESIZE)
  try {
    assert.throws(() => mmap.map('nope', mmap.PROT_READ, mmap.MAP_SHARED, fd), /size/)
    assert.throws(() => mmap.map(mmap.PAGESIZE, 'nope', mmap.MAP_SHARED, fd), /protection/)
  } finally {
    fs.closeSync(fd)
  }
})

test('writes through the mapping reach the file after sync()', () => {
  const size = mmap.PAGESIZE
  const { file, fd } = openScratch(size)
  try {
    const { buf } = mapFile(fd, size)
    buf.writeUInt32LE(0xdeadbeef, 0)
    buf.write('mmap-io', 64, 'utf8')
    mmap.sync(buf, true)

    const onDisk = fs.readFileSync(file)
    assert.equal(onDisk.readUInt32LE(0), 0xdeadbeef)
    assert.equal(onDisk.toString('utf8', 64, 71), 'mmap-io')
  } finally {
    fs.closeSync(fd)
  }
})

test('sync() accepts both the range and the blocking-flag form', () => {
  const size = mmap.PAGESIZE * 2
  const { fd } = openScratch(size)
  try {
    const { buf } = mapFile(fd, size)
    assert.doesNotThrow(() => mmap.sync(buf))
    assert.doesNotThrow(() => mmap.sync(buf, true))
    assert.doesNotThrow(() => mmap.sync(buf, true, false))
    assert.doesNotThrow(() => mmap.sync(buf, 0, mmap.PAGESIZE, true, false))
  } finally {
    fs.closeSync(fd)
  }
})

test('advise() accepts both the 2- and the 4-argument form', () => {
  const size = mmap.PAGESIZE * 2
  const { fd } = openScratch(size)
  try {
    const { buf } = mapFile(fd, size)
    assert.doesNotThrow(() => mmap.advise(buf, mmap.MADV_SEQUENTIAL))
    assert.doesNotThrow(() => mmap.advise(buf, 0, mmap.PAGESIZE, mmap.MADV_WILLNEED))
  } finally {
    fs.closeSync(fd)
  }
})

test('map() applies the optional advise argument', () => {
  const size = mmap.PAGESIZE
  const { fd } = openScratch(size)
  try {
    const sab = mmap.map(size, mmap.PROT_READ, mmap.MAP_SHARED, fd, 0, mmap.MADV_RANDOM)
    assert.equal(sab.byteLength, size)
  } finally {
    fs.closeSync(fd)
  }
})

test('incore() reports an [unmapped, mapped] page tuple', (t) => {
  const size = mmap.PAGESIZE * 2
  const { fd } = openScratch(size)
  try {
    const { buf } = mapFile(fd, size)
    let pages
    try {
      pages = mmap.incore(buf)
    } catch (err) {
      // mman.h stubs mincore() out on Windows.
      if (/not implemented/.test(err.message)) {
        t.skip('mincore() is unavailable on this platform')
        return
      }
      throw err
    }
    assert.equal(pages.length, 2)
    assert.equal(pages[0] + pages[1], size / mmap.PAGESIZE)
  } finally {
    fs.closeSync(fd)
  }
})
