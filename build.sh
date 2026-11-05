#!/bin/bash
# Rebuild ocgcore.wasm (EDOPro's ygopro-core + Lua 5.4) with wasi-sdk 34. Only needed if you change shim.cpp.
# Needs: wasi-sdk-34 in $SDK, ygopro-core cloned to ./ygopro-core, lua/lua @ v5.4.8 in ./lua-src
set -e
SDK=${SDK:-$PWD/wasi-sdk-34.0-x86_64-linux}
F="--target=wasm32-wasip1 --sysroot=$SDK/share/wasi-sysroot -O2 -std=c++17 -fwasm-exceptions -mllvm -wasm-use-legacy-eh=false -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -I./lua-src -I./ygopro-core"
CXX="$SDK/bin/clang++ $F"
mkdir -p out/lua out/core
for f in lapi lauxlib lbaselib lcode lcorolib lctype ldblib ldebug ldo ldump lfunc lgc linit liolib llex lmathlib lmem loadlib lobject lopcodes loslib lparser lstate lstring lstrlib ltable ltablib ltm lundump lutf8lib lvm lzio; do
  cat ygopro-core/lua/luaconf-customize.h lua-src/$f.c > out/lua/$f.cpp
  $CXX -DL_tmpnam=20 -c out/lua/$f.cpp -o out/lua/$f.o
done
for f in card duel effect field interpreter libcard libdebug libduel libeffect libgroup ocgapi operations playerop processor processor_visit scriptlib; do
  $CXX -DOCGCORE_EXPORT_FUNCTIONS -c ygopro-core/$f.cpp -o out/core/$f.o
done
printf '#include <stdio.h>\nextern "C" FILE* tmpfile(void){return nullptr;}\n' > out/stubs.cpp
$CXX -c out/stubs.cpp -o out/stubs.o; $CXX -c shim.cpp -o out/shim.o
$CXX -mexec-model=reactor -Wl,--export-dynamic -lwasi-emulated-signal -lwasi-emulated-process-clocks out/stubs.o out/shim.o out/core/*.o out/lua/*.o -lunwind -o ocgcore.wasm
