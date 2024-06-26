
# mmap-io - Node.js addon for memory mapping files (mid-2024 version)

## Quick info

- Long story short: with this addon you can increase performance of your file interactions by memory mapping files, 
you are "project" some file to RAM and push data to RAM without any interactions with hdd/ssd subsystem -- this module will
facilitate reliable syncing between RAM-file and disk-file.
- It's a fork of mmap-io ([ozra/mmap-io](https://github.com/ozra/mmap-io) -> [Widdershin/mmap-io](https://github.com/Widdershin/mmap-io))
- **mmap-io** is written in C++17 and TypeScript, when you're installing it in your project, you're automatically getting 
a precompiled binary (.node-file) for your platform from Downloads section of this project. 
Otherwise it requires a C++17 compiler and Python 3.12+ on your machine to build.
- **mmap-io** is tested on Node.js 16 (16.14+), 18, 19, 20, 21, 22. Sorry, but there is no Node.js 17 because of some compilation stage issues.
- **mmap-io** has built binaries for Windows x86_64, Linux x86_64, Mac x86_64, Mac ARM.
- Potential use cases: working with big files (like highly volatile game map files), pushing data to cache files, video/audio-processing, messaging mechanics for inter-process communication.

## Quick TS example

```typescript
    import fs from "fs"
    import mmap from "@riaskov/mmap-io"
    
    const file = fs.openSync("/home/ubuntu/some-file-here", "r+")
    const buf = mmap.map(fs.fstatSync(file).size, mmap.PROT_WRITE, mmap.MAP_SHARED, file)
    mmap.advise(buf, mmap.MADV_RANDOM)
    // Now you can work with "buf" as with a regular Buffer object.
    // All your changes will be synced with the file "some-file-here" on disk.
    // For example, add number 1024 at 0 position of buffer:
    // buf.writeUInt32LE(1024, 0)

```


# Fork Notice

This is a fork of mmap-io (https://github.com/Widdershin/mmap-io/), as the upstream repo is no longer maintained and it didn't compile well on my machine for newer Node.js.

This version of mmap-io builds on Node up to 22, and provides binaries for Windows and macOS via @mapbox/node-pre-gyp.

# Author's notice: 
## Mmap for Node.js
mmap(2) / madvise(2) / msync(2) / mincore(2) for node.js revisited.

I needed shared memory mapping and came across @bnoordhuis module [node-mmap](https://github.com/bnoordhuis/node-mmap), only to find that it didn't work with later versions of io.js, node.js and compatibles. So out of need I threw this together along with the functionality I found was missing in the node-mmap: advice and sync.

Strong temptations to re-order arguments to something more sane was kept at bay, and I kept it as mmap(2) and node-mmap for compatibility. Notable difference is the additional optional argument to pass a usage advise in the mapping stage. I've given advise and sync more practical arguments, out of a node.js perspective, compared to their C/C++ counterparts.

The flag constants have crooked names from C/C++ retained in order to make it straight forward for the user to search the net, and relate to man-pages.

This is my first node.js addon and after hours wasted reading up on V8 API I luckily stumbled upon [Native Abstractions for Node](https://github.com/rvagg/nan). Makes life so much easier. Hot tip!

_mmap-io_ is written in C++11 and ~~[LiveScript](https://github.com/gkz/LiveScript)~~ — _although I love LS, it's more prudent to use TypeScript for a library, so I've rewritten that code._

It should be noted that mem-mapping is by nature potentially blocking, and _should not be used in concurrent serving/processing applications_, but rather has it's niche where multiple processes are working on the same giant sets of data (thereby sparing physical memory, and load times if the kernel does it's job for read ahead), preferably multiple readers and single or none concurrent writer, to not spoil the gains by shitloads of spin-locks, mutexes or such. _And your noble specific use case of course._


# News and Updates

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
yarn
```


# Usage

**Note: All code in examples are in LiveScript**

```livescript
# Following code is plastic fruit; not t[ae]sted...

mmap = require "mmap-io"
fs = require "fs"

some-file = "./foo.bar"

fd = fs.open-sync some-file, "r"
fd-w = fs.open-sync some-file, "r+"

# In the following comments:
# - `[blah]` denotes optional argument
# - `foo = x` denotes default value for argument

size = fs.fstat-sync(fd).size
rx-prot = mmap.PROT_READ .|. mmap.PROT_EXECUTE
priv = mmap.MAP_SHARED

# map( size, protection, privacy, fd [, offset = 0 [, advise = 0]] ) -> Buffer
buffer = mmap.map size, rx-prot, priv, fd
buffer2 = mmap.map size, mmap.PROT_READ, priv, fd, 0, mmap.MADV_SEQUENTIAL
w-buffer = mmap.map size, mmap.PROT_WRITE, priv, fd-w

# advise( buffer, advise ) -> void
# advise( buffer, offset, length, advise ) -> void
mmap.advise w-buffer, mmap.MADV_RANDOM

# sync( buffer ) -> void
# sync( buffer, offset, length ) -> void
# sync( buffer, is-blocking-sync[, do-page-invalidation = false] ) -> void
# sync( buffer, offset = 0, length = buffer.length [, is-blocking-sync = false [, do-page-invalidation = false]] ) -> void

mmap.sync w-buffer
mmap.sync w-buffer, true
mmap.sync w-buffer, 0, size
mmap.sync w-buffer, 0, size, true
mmap.sync w-buffer, 0, size, true, false

# incore( buffer ) -> [ unmapped-pages Int, mapped-pages Int ]
core-stats = mmap.incore buffer
```

### Good to Know (TM)

- Checkout man pages mmap(2), madvise(2), msync(2), mincore(2) for more detailed intell.
- The mappings are automatically unmapped when the buffer is garbage collected.
- Write-mappings need the fd to be opened with "r+", or you'll get a permission error (13).
- If you make a read-only mapping and then ignorantly set a value in the buffer, all hell previously unknown to a JS'er breaks loose (segmentation fault). It is possible to write some devilous code to intercept the SIGSEGV and throw an exception, but let's not do that!
- `Offset`, and in some cases `length` needs to be a multiple of mmap-io.PAGESIZE (which commonly is 4096)
- Huge pages are only supported for anonymous / private mappings (well, in Linux), so I didn't throw in flags for that since I found no use.
- As Ben Noordhuis previously has stated: Supplying hint for a fixed virtual memory adress is kinda moot point in JS, so not supported.
- If you miss a feature - contribute! Or request it in an issue.
- If documentation isn't clear, make an issue.


# Tests
```
npm test
```
