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
  'MAP_NONBLOCK',
  'MAP_POPULATE',
  'MADV_NORMAL',
  'MADV_RANDOM',
  'MADV_SEQUENTIAL',
  'MADV_WILLNEED',
  'MADV_DONTNEED',
  'PAGESIZE',
  'ALLOCATIONGRANULARITY'
]

/**
 * Creates a zero-filled scratch file and returns a writable fd for it.
 */
function openScratch(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmap-io-'))
  const file = path.join(dir, 'data.bin')
  fs.writeFileSync(file, Buffer.alloc(bytes))
  const fd = fs.openSync(file, 'r+')
  return { dir, file, fd }
}

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

test('platform-specific flags stay usable in a bitwise or', () => {
  // On non-Linux these are exported as 0 rather than left undefined, so that
  // combining them cannot produce NaN.
  assert.ok(Number.isInteger(mmap.MAP_SHARED | mmap.MAP_POPULATE))
  assert.ok(Number.isInteger(mmap.MAP_SHARED | mmap.MAP_NONBLOCK))
})

test('hides the private sync implementation', () => {
  assert.equal(mmap.sync_lib_private__, undefined)
  assert.equal(typeof mmap.sync, 'function')
  assert.equal(typeof mmap.unmap, 'function')
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
    assert.throws(() => mmap.map(-1, mmap.PROT_READ, mmap.MAP_SHARED, fd), /negative/)
  } finally {
    fs.closeSync(fd)
  }
})

test('map() honours the offset argument', () => {
  // Windows maps at allocation granularity (64 KiB), not page granularity,
  // so an offset of PAGESIZE would be rejected there.
  const offset = mmap.ALLOCATIONGRANULARITY
  const { fd } = openScratch(offset * 2)
  try {
    fs.writeSync(fd, Buffer.from('second-chunk'), 0, 12, offset)
    fs.fsyncSync(fd)

    const sab = mmap.map(offset, mmap.PROT_READ, mmap.MAP_SHARED, fd, offset)
    assert.equal(Buffer.from(sab).toString('utf8', 0, 12), 'second-chunk')
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

test('sync() flushes when handed the SharedArrayBuffer itself', () => {
  // Regression: SharedArrayBuffer has byteLength but no length, so the wrapper
  // used to pass a zero-byte range down and msync() nothing at all.
  const size = mmap.PAGESIZE
  const { file, fd } = openScratch(size)
  try {
    const { sab, buf } = mapFile(fd, size)
    buf.write('through-the-sab', 0, 'utf8')
    mmap.sync(sab, true)

    const onDisk = fs.readFileSync(file)
    assert.equal(onDisk.toString('utf8', 0, 15), 'through-the-sab')
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

test('advise() accepts a SharedArrayBuffer as well as a view', () => {
  const size = mmap.PAGESIZE * 2
  const { fd } = openScratch(size)
  try {
    const { sab, buf } = mapFile(fd, size)
    assert.doesNotThrow(() => mmap.advise(sab, mmap.MADV_SEQUENTIAL))
    assert.doesNotThrow(() => mmap.advise(buf, mmap.MADV_SEQUENTIAL))
    assert.doesNotThrow(() => mmap.advise(buf, 0, mmap.PAGESIZE, mmap.MADV_WILLNEED))
  } finally {
    fs.closeSync(fd)
  }
})

test('advise() rejects things that are not buffers', () => {
  assert.throws(() => mmap.advise({}, mmap.MADV_NORMAL), /SharedArrayBuffer/)
  assert.throws(() => mmap.advise(42, mmap.MADV_NORMAL), /SharedArrayBuffer/)
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
    const { sab } = mapFile(fd, size)
    let pages
    try {
      pages = mmap.incore(sab)
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

test('unmap() releases the mapping and is idempotent', () => {
  const size = mmap.PAGESIZE
  const { fd } = openScratch(size)
  try {
    const sab = mmap.map(size, mmap.PROT_READ, mmap.MAP_SHARED, fd)
    assert.equal(mmap.unmap(sab), true, 'first unmap should do the work')
    assert.equal(mmap.unmap(sab), false, 'second unmap should be a no-op')
    // Deliberately no access to `sab` past this point: the address space is
    // gone, and reading it would fault.
  } finally {
    fs.closeSync(fd)
  }
})

test('unmap() accepts a view over the mapping', () => {
  const size = mmap.PAGESIZE
  const { fd } = openScratch(size)
  try {
    const { buf } = mapFile(fd, size)
    assert.equal(mmap.unmap(buf), true)
  } finally {
    fs.closeSync(fd)
  }
})

test('unmap() rejects buffers it never handed out', () => {
  assert.equal(mmap.unmap(new SharedArrayBuffer(64)), false)
  assert.throws(() => mmap.unmap('nope'), /SharedArrayBuffer/)
})

test('maps a file larger than 2 GiB', (t) => {
  if (process.platform === 'win32') {
    t.skip('sparse-file setup differs enough on Windows to warrant its own test')
    return
  }

  // Regression: size and offset used to be truncated to int, capping mappings
  // at 2 GiB. The file is sparse, so this costs no actual disk space.
  const size = 3 * 1024 ** 3
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmap-io-big-'))
  const file = path.join(dir, 'big.bin')
  const fd = fs.openSync(file, 'w+')
  try {
    fs.ftruncateSync(fd, size)
    const sab = mmap.map(size, mmap.PROT_READ, mmap.MAP_SHARED, fd)
    assert.equal(sab.byteLength, size)
    assert.equal(mmap.unmap(sab), true)
  } finally {
    fs.closeSync(fd)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
