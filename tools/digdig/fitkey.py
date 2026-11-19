# Fit each key byte as the top byte of an affine map mod n = 2^30-1 (approximate model).
import json, sys
d = json.load(open(sys.argv[1]))
K = {S: bytes(k) for S, k, n in d['states']}
n = (1 << 30) - 1
m = 0x7ffffffe
def rot(x, k): k %= 30; return ((x << k) | (x >> (30 - k))) & n
for j in range(7):
    votes = [[0, 0] for _ in range(30)]
    for b in range(30):
        D = (K[1 << b][j] - K[0][j]) & 255
        # D ~ bits [22-b, 30-b) of alpha; trust the top 5 bits
        for t in range(3, 8):
            pos = (22 - b + t) % 30
            votes[pos][(D >> t) & 1] += 1
    alpha = sum((1 << p) for p in range(30) if votes[p][1] > votes[p][0])
    # beta from intervals: top byte of (beta + alpha*S) mod n is k (or k-1 because of |1)
    cands = None
    import random
    # coarse search over beta's top 12 bits, then refine
    def score(beta, tol=1):
        bad = 0
        for S, k in K.items():
            y = (beta + alpha * (S % m)) % n
            if (((y >> 22) | 1) - k[j]) & 255 not in (0, 1, 255, 254) or False: bad += 1
        return bad
    best = min(range(0, n, 1 << 18), key=lambda b: score(b))
    print(j, hex(alpha), 'beta~', hex(best), 'bad', score(best), 'of', len(K))
