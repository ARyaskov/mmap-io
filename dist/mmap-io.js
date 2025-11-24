"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const binary = require('@mapbox/node-pre-gyp');
const path = require('path');
const binding_path = binary.find(path.resolve(path.join(__dirname, '../package.json')));
const mmap_lib_raw_ = require(binding_path);
// snatch the raw C++-sync func
const raw_sync_fn_ = mmap_lib_raw_.sync_lib_private__;
// Hide the original C++11 func from users
delete mmap_lib_raw_.sync_lib_private__;
// Take care of all the param juggling here instead of in C++ code, by making
// some overloads, and doing some argument defaults /ozra
mmap_lib_raw_.sync = function (buf, par_a, par_b, par_c, par_d) {
    // Get the buffer size - use byteLength for SharedArrayBuffer/Uint8Array, length for Buffer
    const bufSize = (buf instanceof SharedArrayBuffer || buf instanceof Uint8Array) ? buf.byteLength : buf.length;
    if (typeof par_a === "boolean") {
        raw_sync_fn_(buf, 0, bufSize, par_a, par_b || false);
    }
    else {
        raw_sync_fn_(buf, par_a || 0, par_b || bufSize, par_c || false, par_d || false);
    }
};
// mmap_lib_raw_.sync = sync_
const mmap = mmap_lib_raw_;
module.exports = mmap;
exports.default = mmap;
