# Follow direct calls and vtable constants from a function and list what it reaches.
#   python3 -I reach.py <captures dir> <func> [max depth]
import re, struct, subprocess, sys, os
D, start = sys.argv[1], int(sys.argv[2])
maxd = int(sys.argv[3]) if len(sys.argv) > 3 else 40
here = os.path.dirname(os.path.abspath(__file__))
elem = None
for line in open(f'{D}/client.wat', encoding='latin1'):
    if line.startswith('  (elem'):
        m = re.search(r'\(i32\.const (\d+)\) func (.*)\)', line)
        base = int(m.group(1)); elem = [int(x) for x in m.group(2).split()]; break
mem = open(f'{D}/mem.bin', 'rb').read()
size = {int(l.split()[0]): int(l.split()[2]) - int(l.split()[1]) for l in open(f'{D}/offsets.txt')}
starts = {int(b): int(a) for a, b in (l.split() for l in open(f'{D}/ffuncs.idx'))}
lines = open(f'{D}/folded.wat', encoding='latin1').read().split('\n')
def text(f):
    s = starts[f] - 1; e = starts.get(f + 1, s + 2) - 1
    return '\n'.join(lines[s:e])
def slot0(a):
    if a + 4 > len(mem): return None
    v = struct.unpack_from('<I', mem, a)[0] - base
    return elem[v] if 0 <= v < len(elem) else None
seen = set()
def walk(f, d):
    if f in seen or d > maxd: return
    seen.add(f)
    t = text(f)
    kids = [int(x) for x in re.findall(r'\(call (\d+)', t)]
    for c in re.findall(r'\(i32\.const (\d{4,6})\)', t):
        k = slot0(int(c))
        if k is not None and int(c) > 1000: kids.append(k)
    big = size.get(f, 0) > 200
    print('  ' * d + f'f{f} {size.get(f)}B' + ('  <==' if big else ''))
    for k in dict.fromkeys(kids):
        if k in (361, 362, 363, 364, 369): continue
        walk(k, d + 1)
walk(start, 0)
