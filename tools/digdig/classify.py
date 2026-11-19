# Guess each snapshot field's value type from its decoder: python3 -I classify.py <fields dir>
import os, re, sys
d = sys.argv[1]
for name in sorted(os.listdir(d)):
    t = open(os.path.join(d, name)).read()
    kinds = []
    if 'f649(' in t: kinds.append('svarint' + ('/4' if '0x1p-2' in t else ''))
    if 'f648(' in t: kinds.append('f648')
    if re.search(r'f32\[\(i32\[v4\] \+ v3\)\]', t): kinds.append('f32')
    if re.search(r'u8\[\(i32\[v4\] \+ v3\)\]', t) and '(v3 + 1)' in t: kinds.append('u8')
    if '<< 28' in t:
        kinds.append('zigzag' if re.search(r'\(0 - \(v\d+ & 1\)\)', t) else 'varint')
    if 'u8[v1] = 0' in t and 'f369' in t: kinds.append('string')
    if 'f32[(i32[v4] + v3)]' not in t and 'f32' in t and not kinds: kinds.append('float?')
    comp = re.findall(r'(f\d+)\(v9\)', t)
    store = [l for l in t.split('\n') if re.search(r'^(u8|i32|f32|f64|u16|i64)\[v\d+\+\d+\] = ', l)]
    print(name[5:8], comp[0] if comp else '-', ','.join(kinds) or '?', '|', (store[-1] if store else '')[:60], f'({t.count(chr(10))}L)')
