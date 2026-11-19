# Cut the client's maze generator (f1008 and what it calls) out of the folded
# disassembly into a small module that exports it as "maze" with its memory as
# "mem", to check games/digdig/maze.js against:
#   python3 -I maze-oracle.py folded.wat maze.wat && wat2wasm maze.wat -o maze.wasm
# then in Node: clear mem at 161815 (145800 bytes), call maze(seed), read it back.
import re, sys

lines = open(sys.argv[1], encoding='latin1').read().split('\n')
types = [l for l in lines if l.startswith('  (type ')]
starts = {}
for i, l in enumerate(lines):
    m = re.match(r'  \(func \(;(\d+);\)', l)
    if m:
        starts[int(m.group(1))] = i
order = sorted(starts.items(), key=lambda x: x[1])
ends = {}
for k, (f, s) in enumerate(order):
    if k + 1 < len(order):
        ends[f] = order[k + 1][1]
    else:
        ends[f] = next(i for i in range(s + 1, len(lines)) if re.match(r'  \((table|export|global|memory|elem|data)', lines[i]))
need, stack = set(), [1008]
while stack:
    f = stack.pop()
    if f in need:
        continue
    need.add(f)
    stack += [int(c) for c in re.findall(r'\(call (\d+)', '\n'.join(lines[starts[f]:ends[f]]))]
out = ['(module'] + types + ['  (memory (export "mem") 128)', '  (global (mut i32) (i32.const 6790112))']
for f in sorted(need):
    body = '\n'.join(lines[starts[f]:ends[f]])
    body = re.sub(r'\(func \(;(\d+);\)', lambda m: '(func $f' + m.group(1), body, count=1)
    out.append(re.sub(r'\(call (\d+)', lambda m: '(call $f' + m.group(1), body))
out.append('  (export "maze" (func $f1008))')
data = [l for l in lines if l.startswith('  (data')]
data[-1] = data[-1].rstrip()
if data[-1].endswith('))'):
    data[-1] = data[-1][:-1]  # the module's own closing paren
out += data + [')']
open(sys.argv[2], 'w', encoding='latin1').write('\n'.join(out))
