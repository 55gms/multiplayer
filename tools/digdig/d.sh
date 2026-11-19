#!/bin/sh
# Decompile functions: tools/digdig/d.sh <index>...
D=$(dirname "$0")/../../captures/digdig
python3 -I $(dirname "$0")/dec.py $D/folded.wat $D/ffuncs.idx "$@"
