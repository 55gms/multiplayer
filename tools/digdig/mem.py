# Flat memory image from a wat file's data segments: python3 -I mem.py client.wat mem.bin
import re, sys
mem = bytearray(1 << 22)
esc = {'n': 10, 't': 9, '"': 34, "'": 39, '\\': 92}
for line in open(sys.argv[1], encoding='latin1'):
    if not line.startswith('  (data'):
        continue
    m = re.match(r'  \(data \(;\d+;\) \(i32\.const (\d+)\) "(.*)"\)\s*$', line)
    if not m:
        continue
    off, s, out, i = int(m.group(1)), m.group(2), bytearray(), 0
    while i < len(s):
        if s[i] == '\\':
            h = s[i + 1:i + 3]
            if re.fullmatch(r'[0-9a-f]{2}', h):
                out.append(int(h, 16)); i += 3; continue
            out.append(esc[s[i + 1]]); i += 2; continue
        out.append(ord(s[i])); i += 1
    mem[off:off + len(out)] = out
open(sys.argv[2], 'wb').write(mem)
