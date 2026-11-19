# Insert logging probes into the client's wat, for tracing what the client reads.
#   python3 -I patch.py client.wat out.wat probes.json
#
# probes.json is a list of {"line": <1-based wat line>, "tag": <int>, "extra": <wat expr>}.
# Each probe goes before that line and logs, through the client's EM_ASM bridge
# (code 999000, which tools/digdig/harness.mjs adds to client.js), the tag, the i32
# on top of the stack (left untouched) and the value of "extra", e.g.
# "(i32.load offset=8 (local.get 4))". The probe needs one scratch local; it is
# added to the probed function.
import json, re, sys

src, dst, spec = sys.argv[1:]
lines = open(src, encoding='latin1').read().split('\n')
probes = json.load(open(spec))
SIG_III = 54000  # "iii" in the client's data

func_starts = [i for i, l in enumerate(lines) if l.startswith('  (func ')]


def func_of(idx):
    lo = 0
    for s in func_starts:
        if s <= idx:
            lo = s
    return lo


def count_locals(header_lines):
    n = 0
    for l in header_lines:
        for grp in re.findall(r'\((param|local)([^()]*)\)', l):
            n += len(grp[1].split())
    return n


scratch = {}
inserts = {}
for p in probes:
    i = p['line'] - 1
    fs = func_of(i)
    if fs not in scratch:
        hdr = [lines[fs]]
        j = fs + 1
        while lines[j].strip().startswith('(local'):
            hdr.append(lines[j]); j += 1
        idx = count_locals(hdr)
        lines[j - 1] = lines[j - 1] if lines[j - 1].strip().startswith('(local') else lines[j - 1]
        if j - 1 > fs and lines[j - 1].strip().startswith('(local'):
            lines[j - 1] = lines[j - 1].rstrip()[:-1] + ' i32)'
        else:
            lines.insert(fs + 1, '    (local i32)')
            # shift everything we computed after this point
            func_starts = [s + 1 if s > fs else s for s in func_starts]
            for q in probes:
                if q['line'] - 1 > fs:
                    q['line'] += 1
            i += 1
        scratch[fs] = idx
    t = scratch[fs]
    extra = p.get('extra', '(i32.const 0)')
    code = f'''local.set {t}
global.get 0 i32.const 64 i32.sub i32.const {p['tag']} i32.store
global.get 0 i32.const 60 i32.sub local.get {t} i32.store
global.get 0 i32.const 56 i32.sub {extra} i32.store
i32.const 999000 i32.const {SIG_III} global.get 0 i32.const 64 i32.sub call 0 drop
local.get {t}'''.replace('\n', ' ')
    inserts.setdefault(p['line'] - 1, []).append(code)

out = []
for i, l in enumerate(lines):
    for c in inserts.get(i, []):
        out.append(c)
    out.append(l)
open(dst, 'w', encoding='latin1').write('\n'.join(out))
print('probes', len(probes), 'scratch locals', scratch)
