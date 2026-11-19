#!/bin/sh
# Print one function from the folded disassembly: tools/digdig/fx.sh <index>
D=$(dirname "$0")/../../captures/digdig
s=$(awk -v F=$1 '$2==F{print $1}' $D/ffuncs.idx); e=$(awk -v F=$1 '$2==F+1{print $1}' $D/ffuncs.idx)
[ -z "$e" ] && e=$(grep -n '^  (table\|^  (export\|^  (elem' $D/folded.wat | head -1 | cut -d: -f1)
sed -n "${s},$((e-1))p" $D/folded.wat
