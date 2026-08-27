
# mmap-io - Node.js addon for memory mapping files (2024 version)

## Quick info

- Long story short: with this addon you can increase performance of your file interactions by memory mapping files, 
you are "project" some file to RAM and push data to RAM without any interactions with hdd/ssd subsystem -- this module will
facilitate reliable syncing between RAM-file and disk-file. [mmap(2)](https://linux.die.net/man/2/mmap) / [madvise(2)](https://linux.die.net/man/2/madvise) 
/ [msync(3)](https://linux.die.net/man/3/msync) / [mincore(2)](https://linux.die.net/man/2/mincore) for Node.js
- It's a fork of mmap-io ([ozra/mmap-io](https://github.com/ozra/mmap-io) -> [Widdershin/mmap-io](https://github.com/Widdershin/mmap-io))
- **mmap-io** is written in C++17 and TypeScript, when you're installing it in your project, you're automatically getting 
a precompiled binary (.node-file) for your platform from Downloads section of this project. 
Otherwise it requires a C++17 compiler and Python 3.12+ on your machine to build.
- **mmap-io** is tested on Node 18, 19, 20, 21, 22, 23, 24, 25 and 26.
- **mmap-io** has built binaries for Windows x86_64, Linux x86_64, Mac x86_64, Mac ARM.
- Potential use cases: working with big files (like highly volatile game map files), pushing data to cache files, video/audio-processing, messaging mechanics for inter-process communication.

## Quick TS example

```typescript
    import fs from "fs"
    import mmap from "@riaskov/mmap-io"
    
    const file = fs.openSync("/home/ubuntu/some-file-here", "r+")

    // map() returns a SharedArrayBuffer, so it can be handed to worker threads
    const mapping = mmap.map(fs.fstatSync(file).size, mmap.PROT_WRITE, mmap.MAP_SHARED, file)
    mmap.advise(mapping, mmap.MADV_RANDOM)

    // Wrap it in a view to read and write bytes
    const buf = Buffer.from(mapping)
    buf.writeUInt32LE(1024, 0)

    // Push the changes out to the file "some-file-here" on disk
    mmap.sync(buf, true)

    // Optional: release the mapping now instead of waiting for the GC
    mmap.unmap(mapping)

```
# News and Updates

### version 1.6.0
- `advise()`, `incore()`, `sync()` and the new `unmap()` accept the
SharedArrayBuffer that `map()` returns, not just views over it
- `sync()` no longer silently syncs a zero-byte range when given a
SharedArrayBuffer
- Sizes and offsets are 64-bit, lifting the old 2 GiB truncation
- New `unmap(buffer)` for releasing a mapping without waiting for the GC
- New `ALLOCATIONGRANULARITY` constant - the alignment `offset` must respect
- `MAP_NONBLOCK` / `MAP_POPULATE` are exported as `0` off Linux instead of
being left undefined
- Prebuilt binaries for Node 18 through 26 on Linux x64, macOS x64/arm64 and
Windows x64

### 2024-07-21: version 1.5.0
- Use SharedArrayBuffer as a base primitive instead of Buffer

### 2024-05-12: version 1.4.3
- Add support for Node 22

# Install
Use npm or git.

```
npm install @riaskov/mmap-io
```

```
git clone https://github.com/ARyaskov/mmap-io.git
cd mmap-io
npm install
```


# Some code examples

```typescript
// Following code is plastic fruit; not t[ae]sted...

import mmap from 'mmap-io';
import fs from 'fs';

const someFile = "./foo.bar";

const fd = fs.openSync(someFile, "r");
const fd_w = fs.openSync(someFile, "r+");

// In the following comments:
// - `[blah]` denotes optional argument
// - `foo = x` denotes default value for argument

const size = fs.fstatSync(fd).size;
const rx_prot = mmap.PROT_READ | mmap.PROT_EXEC;
const priv = mmap.MAP_SHARED;

// map(size, protection, privacy, fd [, offset = 0 [, advise = 0]]): SharedArrayBuffer
const buffer = mmap.map(size, rx_prot, priv, fd);
const buffer2 = mmap.map(size, mmap.PROT_READ, priv, fd, 0, mmap.MADV_SEQUENTIAL);
const w_buffer = mmap.map(size, mmap.PROT_WRITE, priv, fd_w);

// Every call below takes either the SharedArrayBuffer map() returned or any
// view over it, so wrap it whenever you need to touch the bytes themselves.
const w_bytes = Buffer.from(w_buffer);

// advise(buffer, advise): void
// advise(buffer, offset, length, advise): void
mmap.advise(w_buffer, mmap.MADV_RANDOM);

// sync(buffer): void
// sync(buffer, offset, length): void
// sync(buffer, isBlockingSync[, doPageInvalidation = false]): void
// sync(buffer, offset = 0, length = buffer.byteLength [, isBlockingSync = false [, doPageInvalidation = false]]): void

mmap.sync(w_buffer);
mmap.sync(w_buffer, true);
mmap.sync(w_buffer, 0, size);
mmap.sync(w_buffer, 0, size, true);
mmap.sync(w_buffer, 0, size, true, false);

// incore(buffer): [unmappedPages: number, mappedPages: number]
const core_stats = mmap.incore(buffer);

// unmap(buffer): boolean
// Releases the mapping immediately rather than at garbage collection time.
// Returns false if it had already been released.
mmap.unmap(w_buffer);

```

### Good to Know (TM)

- Sizes and offsets cross into C++ as 64-bit integers, so on a 64-bit runtime a
mapping is bounded by free address space and by V8's maximum ArrayBuffer length,
not by this module. (Up to and including 1.5.0 they were truncated to `int`,
which is where the old "1 GiB" ceiling came from.)
- The mappings are automatically unmapped when the buffer is garbage collected.
Call `unmap(buffer)` if you need the address space back at a definite point
instead. After that the mapping is gone: reading or writing any view over it
faults, exactly as it would in C.
- Write-mappings need the fd to be opened with "r+", or you'll get a permission error (13).
- If you make a read-only mapping and then ignorantly set a value in the buffer, all hell previously unknown to a JS'er breaks loose (segmentation fault).
It is possible to write some devilous code to intercept the SIGSEGV and throw an exception, but let's not do that!
- `Offset`, and in some cases `length` needs to be a multiple of `mmap-io.ALLOCATIONGRANULARITY`.
That equals `PAGESIZE` on Linux and macOS, but is 64 KiB on Windows, where the
underlying `MapViewOfFile` works in allocation granularity rather than pages.
- `MAP_NONBLOCK` and `MAP_POPULATE` only exist on Linux. Elsewhere they are
exported as `0`, so `MAP_SHARED | MAP_POPULATE` stays a valid flag word.
- Huge pages are only supported for anonymous / private mappings (well, in Linux), so I didn't throw in flags for that since I found no use.
- As Ben Noordhuis previously has stated: Supplying hint for a fixed virtual memory address is kinda moot point in JS, so not supported.
- If documentation isn't clear, make an issue.

# Tests
```
npm test
```
