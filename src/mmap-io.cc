/*
    Licensed under The MIT License (MIT)
    You will find the full license legal mumbo jumbo in file "LICENSE"

    Copyright (c) 2015 - 2018 Oscar Campbell

    Inspired by Ben Noordhuis module node-mmap - which does the same thing for older node
    versions, sans advise and sync.
*/
#include <nan.h>
#include <errno.h>
#include <mutex>
#include <string>
#include <unordered_map>

#ifdef _WIN32
#include <windows.h>
#include "mman.h"
#else
#include <unistd.h>
#include <sys/mman.h>
#endif

/* #include <future> */

using namespace v8;

// Just a bit more clear as to intent
#define JS_FN(a) NAN_METHOD(a)


/**
 * Bookkeeping for live mappings.
 *
 * A mapping is normally torn down by the SharedArrayBuffer's finalizer, which
 * only runs once the garbage collector gets around to it. unmap() lets callers
 * release the address space right away, so both paths have to agree on who
 * actually calls munmap(). The flag lives in a heap allocation handed to V8 as
 * the deleter's user data; the registry only exists so unmap() can find that
 * flag starting from a buffer.
 */
struct MapState {
    size_t  length;
    bool    released;
};

// Every read and write of a MapState happens under this lock, including the
// delete - which is what keeps unmap() and the finalizer from racing over one.
static std::mutex                               live_maps_lock_;
static std::unordered_map<void*, MapState*>     live_maps_;

static void remember_mapping(void* data, MapState* state) {
    std::lock_guard<std::mutex> guard(live_maps_lock_);
    live_maps_[data] = state;
}

/**
 * Explicit unmap(). Returns true when this call is the one that dropped the
 * mapping, false when it was already gone.
 */
static bool release_mapping(void* data) {
    std::lock_guard<std::mutex> guard(live_maps_lock_);

    auto it = live_maps_.find(data);
    if (it == live_maps_.end()) {
        return false;
    }

    MapState* state = it->second;
    // Drop the record right away: once unmapped the kernel may hand the same
    // address to the next mmap(), and that one brings its own record.
    live_maps_.erase(it);

    if (state->released) {
        return false;
    }

    state->released = true;
    munmap(data, state->length);
    return true;
}

/**
 * SharedArrayBuffer finalizer. Only unmaps if unmap() did not already.
 */
void do_mmap_cleanup(void* data, size_t length, void* deleter_data) {
    auto* state = static_cast<MapState*>(deleter_data);

    if (state == nullptr) {
        munmap(data, length);
        return;
    }

    std::lock_guard<std::mutex> guard(live_maps_lock_);

    auto it = live_maps_.find(data);
    // Only our own record: the address may since have been remapped.
    if (it != live_maps_.end() && it->second == state) {
        live_maps_.erase(it);
    }

    if (!state->released) {
        state->released = true;
        munmap(data, state->length);
    }

    delete state;
}

inline int do_mmap_advice(char* addr, size_t length, int advise) {
    return madvise(static_cast<void*>(addr), length, advise);
}


/*

disables fancy C++17 code for now because of brickwall time consumption of
getting compilers to work on travis, etc...

/ **
 * Make it simpler the next time V8 breaks API's and such with a wrapper fn...
 * /
template <typename T, typename VT>
inline auto get_v(VT v8_value) -> T {
    if constexpr (std::is_same<unsigned long, T>::value) {
        return static_cast<size_t>(Nan::To<int>(v8_value).FromJust());
    } else {
        return Nan::To<T>(v8_value).FromJust();
    }
}

/ **
 * Make it simpler the next time V8 breaks API's and such with a wrapper fn...
 * /
template <typename T, typename VT>
inline auto get_v(VT v8_value, T default_value) -> T {
    if constexpr (std::is_same<unsigned long, T>::value) {
        return static_cast<size_t>(Nan::To<int>(v8_value).FromMaybe(static_cast<int>(default_value)));
    } else {
        return Nan::To<T>(v8_value).FromMaybe(default_value);
    }
}

*/

/**
 * Make it simpler the next time V8 breaks API's and such with a wrapper fn...
 */
template <typename T, typename VT>
inline auto get_v(VT v8_value) -> T {
    return Nan::To<T>(v8_value).FromJust();
}

/**
 * Make it simpler the next time V8 breaks API's and such with a wrapper fn...
 */
template <typename T, typename VT>
inline auto get_v(VT v8_value, T default_value) -> T {
    return Nan::To<T>(v8_value).FromMaybe(default_value);
}

/**
 * A stretch of mapped bytes, resolved from whatever the caller passed in.
 *
 * "base" is the start of the whole buffer - the key unmap() looks up - while
 * "data" is where the caller's view begins.
 */
struct MemRegion {
    char*   base;
    char*   data;
    size_t  length;
};

/**
 * map() hands out a SharedArrayBuffer, but callers routinely wrap it in a
 * Buffer to read and write bytes. Accept both, plus plain ArrayBuffers, so
 * that whatever a caller happens to be holding works.
 */
inline bool get_mem_region(Local<Value> value, MemRegion& region) {
    if (value->IsSharedArrayBuffer()) {
        auto store = value.As<v8::SharedArrayBuffer>()->GetBackingStore();
        region.base   = static_cast<char*>(store->Data());
        region.data   = region.base;
        region.length = store->ByteLength();
        return true;
    }

    if (value->IsArrayBuffer()) {
        auto store = value.As<v8::ArrayBuffer>()->GetBackingStore();
        region.base   = static_cast<char*>(store->Data());
        region.data   = region.base;
        region.length = store->ByteLength();
        return true;
    }

    if (value->IsArrayBufferView()) {
        auto view  = value.As<v8::ArrayBufferView>();
        auto store = view->Buffer()->GetBackingStore();
        region.base   = static_cast<char*>(store->Data());
        region.data   = region.base + view->ByteOffset();
        region.length = view->ByteLength();
        return true;
    }

    return false;
}

template <typename VT>
inline auto get_obj(VT v8_obj) -> Local<Object> {
    return Nan::To<Object>(v8_obj).ToLocalChecked();
}

JS_FN(mmap_map) {
    Nan::HandleScope scope;

    if (info.Length() < 4 || info.Length() > 7) {
        return Nan::ThrowError(
            "map() takes 4, 5, 6 or 7 arguments: (size :int, protection :int, flags :int, fd :int [, offset :int [, advise :int [, name :string ]])."
        );
    }

    // Try to be a little (motherly) helpful to us poor clueless developers
    if (!info[0]->IsNumber())    return Nan::ThrowError("mmap: size (arg[0]) must be an integer");
    if (!info[1]->IsNumber())    return Nan::ThrowError("mmap: protection_flags (arg[1]) must be an integer");
    if (!info[2]->IsNumber())    return Nan::ThrowError("mmap: flags (arg[2]) must be an integer");
    if (!info[3]->IsNumber())    return Nan::ThrowError("mmap: fd (arg[3]) must be an integer (a file descriptor)");
    // Offset and advise are optional

    // Sizes and offsets go through int64_t, not int: mappings well past 2 GiB
    // are the whole point of this module on 64-bit systems.
    const int64_t   size_arg        = get_v<int64_t>(info[0]);
    const int64_t   offset_arg      = get_v<int64_t>(info[4], 0);

    if (size_arg < 0)   return Nan::ThrowError("mmap: size (arg[0]) must not be negative");
    if (offset_arg < 0) return Nan::ThrowError("mmap: offset (arg[4]) must not be negative");

    constexpr void* hinted_address  = nullptr;  // Just making things uber-clear...
    const size_t    size            = static_cast<size_t>(size_arg);
    const int       protection      = get_v<int>(info[1]);
    const int       flags           = get_v<int>(info[2]);
    const int       fd              = get_v<int>(info[3]);
    const size_t    offset          = static_cast<size_t>(offset_arg);
    const int       advise          = get_v<int>(info[5], 0);

#ifdef _WIN32
    char* nameData = nullptr;

    if (info.Length() > 6 && !info[6]->IsUndefined() && !info[6]->IsNull()) {
      if (!node::Buffer::HasInstance(info[6])) {
        return Nan::ThrowError("mmap: name (arg[6]) must be a Buffer");
      }
      nameData = node::Buffer::Data(get_obj(info[6]));
    }

    char* data = static_cast<char*>( mmap( hinted_address, size, protection, flags, fd, offset, nameData) );
#else
    char* data = static_cast<char*>( mmap( hinted_address, size, protection, flags, fd, offset) );
#endif

    if (data == MAP_FAILED) {
        return Nan::ThrowError((std::string("mmap failed, ") + std::to_string(errno)).c_str());
    }
    else {
        if (advise != 0) {
            auto ret = do_mmap_advice(data, size, advise);
            if (ret) {
                // Grab errno before munmap() gets a chance to clobber it, and
                // do not leak the mapping we are about to throw away.
                const int advise_errno = errno;
                munmap(data, size);
                return Nan::ThrowError((std::string("madvise() failed, ") + std::to_string(advise_errno)).c_str());
            }

        //     // Asynchronous read-ahead to minimisze blocking. This
        //     // has worked flawless, but is not necessary, and any
        //     // gains are speculative.
        //     //
        //     // Play with it if you want to.
        //     //
        //     std::async(std::launch::async, [=](){
        //         auto ret = do_mmap_advice(data, size, advise);
        //         if (ret) {
        //             return Nan::ThrowError((std::string("madvise() failed, ") + std::to_string(errno)).c_str());
        //         }
        //         readahead(fd, offset, 1024 * 1024 * 4);
        //     });

        }

        auto* state = new MapState{ size, false };
        remember_mapping(data, state);

        std::shared_ptr<BackingStore> backingStore = v8::SharedArrayBuffer::NewBackingStore(data, size, do_mmap_cleanup, state);
        Nan::MaybeLocal<Object> buf = v8::SharedArrayBuffer::New(v8::Isolate::GetCurrent(), backingStore);
        if (buf.IsEmpty()) {
            return Nan::ThrowError(std::string("couldn't allocate Node SharedArrayBuffer()").c_str());
        } else {
            info.GetReturnValue().Set(buf.ToLocalChecked());
        }
    }
}

JS_FN(mmap_unmap) {
    Nan::HandleScope scope;

    if (info.Length() != 1) {
        return Nan::ThrowError("unmap() takes 1 argument: (buffer :SharedArrayBuffer).");
    }

    MemRegion region;
    if (!get_mem_region(info[0], region)) {
        return Nan::ThrowError("unmap(): buffer (arg[0]) must be a SharedArrayBuffer, an ArrayBuffer, or a view over one");
    }

    // Reading or writing the buffer after this point is a use-after-free as
    // far as the OS is concerned - that is inherent to releasing a mapping
    // early, and is why the finalizer remains the default path.
    info.GetReturnValue().Set(release_mapping(region.base));
}

JS_FN(mmap_advise) {
    Nan::HandleScope scope;

    if (info.Length() != 2 && info.Length() != 4) {
        return Nan::ThrowError(
            "advise() takes 2 or 4 arguments: (buffer :Buffer, advise :int) | (buffer :Buffer, offset :int, length :int, advise :int)."
        );
    }

    MemRegion region;
    if (!get_mem_region(info[0], region)) {
        return Nan::ThrowError("advise(): buffer (arg[0]) must be a SharedArrayBuffer, an ArrayBuffer, or a view over one");
    }
    if (!info[1]->IsNumber())    return Nan::ThrowError("advise(): (arg[1]) must be an integer");

    int ret = ([&]() -> int {
        if (info.Length() == 2) {
            int advise = get_v<int>(info[1], 0);
            return do_mmap_advice(region.data, region.length, advise);
        }
        else {
            int64_t offset = get_v<int64_t>(info[1], 0);
            int64_t length = get_v<int64_t>(info[2], 0);
            int     advise = get_v<int>(info[3], 0);
            return do_mmap_advice(region.data + offset, static_cast<size_t>(length), advise);
        }
    })();

    if (ret) {
        return Nan::ThrowError((std::string("madvise() failed, ") + std::to_string(errno)).c_str());
    }

    //Nan::ReturnUndefined();
}

JS_FN(mmap_incore) {
    Nan::HandleScope scope;

    if (info.Length() != 1) {
        return Nan::ThrowError(
            "incore() takes 1 argument: (buffer :Buffer) ."
        );
    }

    MemRegion region;
    if (!get_mem_region(info[0], region)) {
        return Nan::ThrowError("incore(): buffer (arg[0]) must be a SharedArrayBuffer, an ArrayBuffer, or a view over one");
    }

    char*           data    = region.data;
    size_t          size    = region.length;

#ifdef _WIN32
    SYSTEM_INFO sysinfo;
    GetSystemInfo(&sysinfo);
    size_t          page_size = sysinfo.dwPageSize;
#else
    size_t          page_size = sysconf(_SC_PAGESIZE);
#endif

    size_t          needed_bytes = (size+page_size-1) / page_size;
    size_t          pages = size / page_size;

#ifdef __APPLE__
    char*  result_data = static_cast<char *>(malloc(needed_bytes));
#else
    unsigned char*  result_data = static_cast<unsigned char *>(malloc(needed_bytes));
#endif

    if (size % page_size > 0) {
        pages++;
    }

    int ret = mincore(data, size, result_data);

    if (ret) {
        free(result_data);
        if (errno == ENOSYS) {
            return Nan::ThrowError("mincore() not implemented");
        } else {
            return Nan::ThrowError((std::string("mincore() failed, ") + std::to_string(errno)).c_str());
        }
    }

    // Now we want to check all of the pages
    uint32_t pages_mapped = 0;
    uint32_t pages_unmapped = 0;

    for(size_t i = 0; i < pages; i++) {
        if(!(result_data[i] & 0x1)) {
            pages_unmapped++;
        } else {
            pages_mapped++;
        }
    }

    free(result_data);

    v8::Local<v8::Array> arr = Nan::New<v8::Array>(2);
    Nan::Set(arr, 0, Nan::New(pages_unmapped));
    Nan::Set(arr, 1, Nan::New(pages_mapped));
    info.GetReturnValue().Set(arr);
}

JS_FN(mmap_sync_lib_private_) {
    Nan::HandleScope scope;

    // I barfed at the thought of implementing all variants of info-combos in C++, so
    // the arg-shuffling and checking is done in a ES wrapper function - see "mmap-io.ts"
    if (info.Length() != 5) {
        return Nan::ThrowError(
            "sync() takes 5 arguments: (buffer :Buffer, offset :int, length :int, do_blocking_sync :bool, invalidate_pages_and_signal_refresh_to_consumers :bool)."
        );
    }

    MemRegion region;
    if (!get_mem_region(info[0], region)) {
        return Nan::ThrowError("sync(): buffer (arg[0]) must be a SharedArrayBuffer, an ArrayBuffer, or a view over one");
    }

    int64_t         offset          = get_v<int64_t>(info[1], 0);
    int64_t         length          = get_v<int64_t>(info[2], 0);
    bool            blocking_sync   = get_v<bool>(info[3], false);
    bool            invalidate      = get_v<bool>(info[4], false);
    int             flags           = ( (blocking_sync ? MS_SYNC : MS_ASYNC) | (invalidate ? MS_INVALIDATE : 0) );

    if (offset < 0) return Nan::ThrowError("sync(): offset (arg[1]) must not be negative");
    if (length < 0) return Nan::ThrowError("sync(): length (arg[2]) must not be negative");

    int ret = msync(region.data + offset, static_cast<size_t>(length), flags);

    if (ret) {
        return Nan::ThrowError((std::string("msync() failed, ") + std::to_string(errno)).c_str());
    }
    //Nan::ReturnUndefined();
}


NAN_MODULE_INIT(Init) {
    auto exports = target;

    constexpr auto std_property_attrs = static_cast<PropertyAttribute>(
        ReadOnly | DontDelete
    );

    using JsFnType = decltype(mmap_map);

    auto set_int_prop = [&](const char* key, int val) -> void {
        Nan::DefineOwnProperty(
            exports,
            Nan::New(key).ToLocalChecked(),
            Nan::New(val),
            std_property_attrs
        );
    };

    auto set_fn_prop = [&](const char* key, JsFnType fn) -> void {
        Nan::DefineOwnProperty(
            exports,
            Nan::New<v8::String>(key).ToLocalChecked(),
            Nan::GetFunction(Nan::New<FunctionTemplate>(fn)).ToLocalChecked(),
            std_property_attrs
        );
    };

    set_int_prop("PROT_READ", PROT_READ);
    set_int_prop("PROT_WRITE", PROT_WRITE);
    set_int_prop("PROT_EXEC", PROT_EXEC);
    set_int_prop("PROT_NONE", PROT_NONE);

    set_int_prop("MAP_SHARED", MAP_SHARED);
    set_int_prop("MAP_PRIVATE", MAP_PRIVATE);

    // Linux-only hints. Exported as a no-op bit elsewhere so that expressions
    // like `MAP_SHARED | MAP_POPULATE` stay valid flag words on every platform
    // instead of evaluating to NaN.
#ifdef MAP_NONBLOCK
    set_int_prop("MAP_NONBLOCK", MAP_NONBLOCK);
#else
    set_int_prop("MAP_NONBLOCK", 0);
#endif

#ifdef MAP_POPULATE
    set_int_prop("MAP_POPULATE", MAP_POPULATE);
#else
    set_int_prop("MAP_POPULATE", 0);
#endif

    set_int_prop("MADV_NORMAL", MADV_NORMAL);
    set_int_prop("MADV_RANDOM", MADV_RANDOM);
    set_int_prop("MADV_SEQUENTIAL", MADV_SEQUENTIAL);
    set_int_prop("MADV_WILLNEED", MADV_WILLNEED);
    set_int_prop("MADV_DONTNEED", MADV_DONTNEED);

    //set_int_prop("MS_ASYNC", MS_ASYNC);
    //set_int_prop("MS_SYNC", MS_SYNC);
    //set_int_prop("MS_INVALIDATE", MS_INVALIDATE);

#ifdef _WIN32
    SYSTEM_INFO sysinfo;
    GetSystemInfo(&sysinfo);
    set_int_prop("PAGESIZE", sysinfo.dwPageSize);
    // MapViewOfFile() wants the offset aligned to the allocation granularity,
    // which is 64 KiB - coarser than a page. Callers passing an offset need
    // this number, not PAGESIZE, to stay portable.
    set_int_prop("ALLOCATIONGRANULARITY", sysinfo.dwAllocationGranularity);
#else
    set_int_prop("PAGESIZE", sysconf(_SC_PAGESIZE));
    set_int_prop("ALLOCATIONGRANULARITY", sysconf(_SC_PAGESIZE));
#endif


    set_fn_prop("map", mmap_map);
    set_fn_prop("unmap", mmap_unmap);
    set_fn_prop("advise", mmap_advise);
    set_fn_prop("incore", mmap_incore);

    // This one is wrapped by a JS-function and deleted from obj to hide from user
    Nan::DefineOwnProperty(
        exports,
        Nan::New<v8::String>("sync_lib_private__").ToLocalChecked(),
        Nan::GetFunction(Nan::New<FunctionTemplate>(mmap_sync_lib_private_)).ToLocalChecked(),
        static_cast<PropertyAttribute>(0)
    );


}

NAN_MODULE_WORKER_ENABLED(mmap_io, Init);
