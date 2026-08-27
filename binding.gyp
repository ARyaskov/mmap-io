{
    "targets": [{
        "target_name": "mmap_io",
        "sources": [ "src/mmap-io.cc" ],
        "include_dirs": [
            "<!(node -e \"require('nan')\")"
        ],
        # Deliberately no -std= flag anywhere in this file. Node ships the
        # right one in its own common.gypi - C++17 through Node 22, C++20 from
        # Node 23 on, where v8config.h hard-errors below C++20. Pinning a
        # standard here overrode that and broke every build on Node 23+:
        #   cl : warning D9025: overriding '/std:c++20' with '/std:c++17'
        #   v8config.h(13,1): error C1189: #error: "C++20 or later required."

        # node-gyp's common.gypi compiles with -fno-exceptions by default; the
        # std::string error paths in mmap-io.cc need exceptions enabled.
        "cflags_cc!": [
            "-fno-exceptions"
        ],
        "conditions": [
            [ 'OS=="mac"',
                { "xcode_settings": {
                    'OTHER_LDFLAGS': ['-stdlib=libc++'],
                    'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
                    # 10.15 is the floor Node 18+ itself ships against; the old
                    # 10.8 value is below what current Xcode will target.
                    'MACOSX_DEPLOYMENT_TARGET': '10.15'
                }}
            ],
            [ 'OS=="win"',
                {
                    # ExceptionHandling 1 is how gyp spells /EHsc.
                    "msvs_settings": {
                        "VCCLCompilerTool": {
                            "ExceptionHandling": 1
                        }
                    },
                    "defines": [ "_HAS_EXCEPTIONS=1" ]
                }
            ]
        ]
    },
    {
      "target_name": "action_after_build",
      "type": "none",
      "dependencies": [ "<(module_name)" ],
      "copies": [
        {
          "files": [ "<(PRODUCT_DIR)/<(module_name).node" ],
          "destination": "<(module_path)"
        }
      ]
    }]
}
