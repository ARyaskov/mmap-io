const binary = require('@mapbox/node-pre-gyp');
const path = require('path');
const binding_path = binary.find(path.resolve(path.join(__dirname,'../package.json')));
const mmap_lib_raw_ = require(binding_path);

type FileDescriptor = number

/**
 * What every entry point taking a mapping will accept.
 *
 * `map()` returns a SharedArrayBuffer, but reading and writing bytes means
 * wrapping it in a view (`Buffer.from(sab)`), so both forms have to work.
 */
type MmapBuffer = SharedArrayBuffer | ArrayBuffer | ArrayBufferView

type MapProtectionFlags =
    | MmapIo["PROT_NONE"] // 0
    | MmapIo["PROT_READ"] // 1
    | MmapIo["PROT_WRITE"] // 2
    | MmapIo["PROT_EXEC"] // 4
    | 3 // R+W
    | 5 // R+X
    | 6 // W+X
    | 7 // R+W+X

// making `map` a wrapper around the C++ `map`-implementation and allowing an
// array of flags would be clean, perfectly literally typed, and the dirtier
// binary-or can be done in the wrapper.
//
// type MapProtectionFlagsList = Array<
//     | MmapIo["PROT_NONE"]
//     | MmapIo["PROT_READ"]
//     | MmapIo["PROT_WRITE"]
//     | MmapIo["PROT_EXEC"]
// >

type MapFlags =
    | MmapIo["MAP_PRIVATE"]
    | MmapIo["MAP_SHARED"]
    | MmapIo["MAP_NONBLOCK"]
    | MmapIo["MAP_POPULATE"]
    | number

type MapAdvise =
    | MmapIo["MADV_NORMAL"]
    | MmapIo["MADV_RANDOM"]
    | MmapIo["MADV_SEQUENTIAL"]
    | MmapIo["MADV_WILLNEED"]
    | MmapIo["MADV_DONTNEED"]

type MmapIo = {
    map(
        size: number,
        protection: MapProtectionFlags,
        flags: MapFlags,
        fd: FileDescriptor,
        offset?: number,
        advise?: MapAdvise,
        name?: Buffer
    ): SharedArrayBuffer

    /**
     * Releases the mapping right away instead of waiting for the garbage
     * collector to finalize the SharedArrayBuffer.
     *
     * Returns true when this call did the unmapping, false when the mapping
     * was already gone. Touching the buffer afterwards reads or writes address
     * space that no longer belongs to the process - so only call this once
     * every view over the mapping is out of use.
     */
    unmap(buffer: MmapBuffer): boolean

    advise(
        buffer: MmapBuffer,
        offset: number,
        length: number,
        advise: MapAdvise
    ): void
    advise(buffer: MmapBuffer, advise: MapAdvise): void

    /// Returns tuple of [ unmapped-pages-count, mapped-pages-count ]
    incore(buffer: MmapBuffer): [number, number]

    sync(
        buffer: MmapBuffer,
        offset?: number,
        size?: number,
        blocking_sync?: boolean,
        invalidate_pages?: boolean
    ): void

    sync(
        buffer: MmapBuffer,
        blocking_sync: boolean,
        invalidate_pages?: boolean
    ): void

    readonly PROT_READ: 1
    readonly PROT_WRITE: 2
    readonly PROT_EXEC: 4
    readonly PROT_NONE: 0
    readonly MAP_SHARED: 1
    readonly MAP_PRIVATE: 2

    /** Linux-only hint. 0 on platforms whose mmap(2) has no such flag. */
    readonly MAP_NONBLOCK: number
    /** Linux-only hint. 0 on platforms whose mmap(2) has no such flag. */
    readonly MAP_POPULATE: number

    readonly MADV_NORMAL: 0
    readonly MADV_RANDOM: 1
    readonly MADV_SEQUENTIAL: 2
    readonly MADV_WILLNEED: 3
    readonly MADV_DONTNEED: 4

    readonly PAGESIZE: number

    /**
     * Alignment the `offset` argument of `map()` has to respect. Equal to
     * PAGESIZE on POSIX; 64 KiB on Windows, where MapViewOfFile() works in
     * allocation granularity rather than pages.
     */
    readonly ALLOCATIONGRANULARITY: number
}

// snatch the raw C++-sync func
const raw_sync_fn_ = mmap_lib_raw_.sync_lib_private__

// Hide the original C++11 func from users
delete mmap_lib_raw_.sync_lib_private__

// Take care of all the param juggling here instead of in C++ code, by making
// some overloads, and doing some argument defaults /ozra
mmap_lib_raw_.sync = function(
    buf: MmapBuffer,
    par_a?: any,
    par_b?: any,
    par_c?: any,
    par_d?: any
): void {
    // Every accepted buffer kind carries byteLength. `length` only exists on
    // views, so reading it here used to hand C++ an undefined - and therefore
    // zero - length whenever a bare SharedArrayBuffer was passed, making the
    // whole call a silent no-op.
    const byte_length_ = buf.byteLength

    if (typeof par_a === "boolean") {
        raw_sync_fn_(buf, 0, byte_length_, par_a, par_b || false)
    } else {
        raw_sync_fn_(
            buf,
            par_a || 0,
            par_b || byte_length_,
            par_c || false,
            par_d || false
        )
    }
}

// mmap_lib_raw_.sync = sync_

const mmap = mmap_lib_raw_ as MmapIo
module.exports = mmap
export default mmap
