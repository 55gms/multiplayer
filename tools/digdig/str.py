# Print the C string at each address: python3 -I str.py mem.bin 1234 5678
import sys
m = open(sys.argv[1], 'rb').read()
for a in map(int, sys.argv[2:]):
    print(a, repr(m[a:m.index(0, a)].decode('utf8', 'replace')))
