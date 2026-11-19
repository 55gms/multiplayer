#!/bin/sh
# Which functions mention a constant: tools/digdig/xref.sh <number>...
D=$(dirname "$0")/../../captures/digdig
for v in "$@"; do
  grep -n "i32.const $v)" $D/folded.wat | cut -d: -f1 | while read L; do awk -v L=$L '$1<L{x=$2} END{print x}' $D/ffuncs.idx; done | sort -u | sed "s/^/$v: f/"
done
