# Byte offset of each function body in a wasm file: python3 -I offsets.py client.wasm > offsets.txt
# Prints "<func index> <body start> <body end>" (module offsets, which is what Chrome breakpoints take).
import sys
b = open(sys.argv[1], 'rb').read()

def leb(p):
    r = s = 0
    while True:
        x = b[p]; p += 1; r |= (x & 127) << s; s += 7
        if x < 128: return r, p

p, nimp = 8, 0
while p < len(b):
    sid = b[p]; size, q = leb(p + 1); end = q + size
    if sid == 2:
        n, q = leb(q)
        for _ in range(n):
            for _ in range(2):
                l, q = leb(q); q += l
            k = b[q]; q += 1
            if k == 0: nimp += 1; _, q = leb(q)
            elif k == 1: q += 1; f = b[q]; q += 1; _, q = leb(q); q = leb(q)[1] if f & 1 else q
            elif k == 2: f = b[q]; q += 1; _, q = leb(q); q = leb(q)[1] if f & 1 else q
            elif k == 3: q += 2
    if sid == 10:
        n, q = leb(q)
        for i in range(n):
            sz, r = leb(q)
            print(nimp + i, r, r + sz)
            q = r + sz
    p = end
