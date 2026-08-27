{
    "targets": [{
        "target_name": "mmap_io",
        "sources": [ "src/mmap-io.cc" ],
        "include_dirs": [
            "<!(node -e \"require('nan')\")"
        ],
        "cflags_cc": [
            "-std=c++17"
        ],
        # node-gyp's common.gypi compiles with -fno-exceptions by default; the
        # std::string error paths in mmap-io.cc need exceptions enabled.
        "cflags_cc!": [
            "-fno-exceptions"
        ],
        "conditions": [
            [ 'OS=="mac"',
                { "xcode_settings": {
                    'OTHER_CPLUSPLUSFLAGS' : ['-std=c++17','-stdlib=libc++'],
                    'OTHER_LDFLAGS': ['-stdlib=libc++'],
                    'GCC_ENABLE_CPP_EXCEPTIONS': 'YES',
                    # 10.15 is the floor Node 18+ itself ships against; the old
                    # 10.8 value is below what current Xcode will target.
                    'MACOSX_DEPLOYMENT_TARGET': '10.15'
                }}
            ],
            [ 'OS=="win"',
                {
                    # MSVC ignores -std=c++17; it needs its own switch, and
                    # ExceptionHandling 1 is how gyp spells /EHsc.
                    "msvs_settings": {
                        "VCCLCompilerTool": {
                            "AdditionalOptions": [ "/std:c++17" ],
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
