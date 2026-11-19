# Intersect per-sample windows for beta given alpha: python3 -I refine.py oracle.json validate.json
import json, sys
n = (1 << 30) - 1; m = 0x7ffffffe
o = json.load(open(sys.argv[1])); v = json.load(open(sys.argv[2]))
AL = [0x171f0ac3, 0x290015ad, 0x2424bddc, 0x82f53b8, 0x2c2f80d6, 0x19f2af18, 0x1b35269]
BE = [0x5844000, 0x2ec20000, 0x9c5c000, 0x3acc0000, 0x19440000, 0x23c30000, 0xa000000]
def samples(j):
    out = [(S, k[j]) for S, k, _ in o['states']]
    out += [(S, kk) for S, kk, _ in v['bad'][j]]
    return out
def window(al, j, be0):
    lo, hi = -(1 << 29), (1 << 29)  # beta - be0 in [lo, hi)
    for S, k in samples(j):
        t0 = (k - 1) & 255 if k & 1 else k  # true top byte is k-1 or k
        start = (t0 << 22) - al * (S % m)  # beta in [start, start + 2^23) mod n
        rel = (start - be0) % n
        if rel > n // 2: rel -= n
        lo, hi = max(lo, rel), min(hi, rel + (1 << 23))
        if lo >= hi: return None
    return lo, hi
for j in range(7):
    w = window(AL[j], j, BE[j])
    print(j, 'alpha', hex(AL[j]), 'beta window', None if w is None else (hex((BE[j] + w[0]) % n), hex((BE[j] + w[1]) % n), w[1] - w[0]))
