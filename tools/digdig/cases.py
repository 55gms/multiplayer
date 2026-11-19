# Split f996's field switch into one block of code per field index.
#   python3 -I cases.py f996.c <switch line> <outdir>
import re, sys, os
src, swline, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
lines = open(src).read().split('\n')
sw = lines[swline - 1]
expr = re.search(r'switch \(\(\(v24 = \(v6 \+ v24\)\) - (\d+)\)\)', sw)
base = int(expr.group(1))
labels = re.search(r'\[(.*)\] default (@\d+)', sw)
targets = [x.strip() for x in labels.group(1).split(',')]
ends = {}
for i, l in enumerate(lines):
    m = re.search(r'\} // end (@\d+)$', l)
    if m and i > swline:
        ends.setdefault(m.group(1), i)
os.makedirs(out, exist_ok=True)
for k, lab in enumerate(targets):
    start = ends[lab]
    nxt = sorted(v for v in ends.values() if v > start)
    stop = nxt[0] if nxt else start + 200
    body = '\n'.join(l.strip() for l in lines[start + 1:stop])
    open(f'{out}/field{k + base:03d}.c', 'w').write(body + '\n')
print(len(targets), 'cases, base', base)
