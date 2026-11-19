# Resolve vtable slots to wasm functions: python3 -I vt.py client.wat mem.bin offsets.txt <vtable addr>...
import re, struct, sys
wat, memf, offf, *addrs = sys.argv[1:]
elem = None
for line in open(wat, encoding='latin1'):
    if line.startswith('  (elem'):
        m = re.search(r'\(i32\.const (\d+)\) func (.*)\)', line)
        base = int(m.group(1)); elem = [int(x) for x in m.group(2).split()]
        break
mem = open(memf, 'rb').read()
size = {}
for l in open(offf):
    f, s, e = map(int, l.split()); size[f] = e - s
for a in map(int, addrs):
    out = []
    for k in range(8):
        v = struct.unpack_from('<I', mem, a + 4 * k)[0]
        i = v - base
        if 0 <= i < len(elem):
            f = elem[i]; out.append(f'[{k}]f{f}({size.get(f, "imp")}B)')
        else:
            out.append(f'[{k}]{v}')
    print(a, ' '.join(out))
