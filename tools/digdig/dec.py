# Turn one function of a folded wat (wasm2wat -f) into C-like pseudocode.
#   python3 -I dec.py folded.wat ffuncs.idx <func index> [more indexes]
import re
import sys

TOK = re.compile(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()]+')


def parse(text):
    text = re.sub(r';;[^\n]*', '', text)
    text = re.sub(r'\(;[^;]*;\)', '', text)
    stack = [[]]
    for t in TOK.findall(text):
        if t == '(':
            stack.append([])
        elif t == ')':
            x = stack.pop()
            stack[-1].append(x)
        else:
            stack[-1].append(t)
    return stack[0]


BIN = {
    'add': '+', 'sub': '-', 'mul': '*', 'div_s': '/', 'div_u': '/u', 'rem_s': '%', 'rem_u': '%u', 'and': '&', 'or': '|',
    'xor': '^', 'shl': '<<', 'shr_s': '>>', 'shr_u': '>>>', 'eq': '==', 'ne': '!=', 'lt_s': '<', 'lt_u': '<u',
    'gt_s': '>', 'gt_u': '>u', 'le_s': '<=', 'le_u': '<=u', 'ge_s': '>=', 'ge_u': '>=u', 'lt': '<', 'gt': '>',
    'le': '<=', 'ge': '>=', 'div': '/', 'rotl': 'rotl', 'rotr': 'rotr', 'min': 'min', 'max': 'max', 'copysign': 'copysign',
}
LOADS = {
    'i32.load': 'i32', 'i64.load': 'i64', 'f32.load': 'f32', 'f64.load': 'f64', 'i32.load8_u': 'u8', 'i32.load8_s': 's8',
    'i32.load16_u': 'u16', 'i32.load16_s': 's16', 'i64.load8_u': 'u8', 'i64.load8_s': 's8', 'i64.load16_u': 'u16',
    'i64.load16_s': 's16', 'i64.load32_u': 'u32', 'i64.load32_s': 's32',
}
STORES = {
    'i32.store': 'i32', 'i64.store': 'i64', 'f32.store': 'f32', 'f64.store': 'f64', 'i32.store8': 'u8', 'i32.store16': 'u16',
    'i64.store8': 'u8', 'i64.store16': 'u16', 'i64.store32': 'u32',
}


def opts(node):
    o, rest = {}, []
    for x in node[1:]:
        if isinstance(x, str) and '=' in x:
            k, v = x.split('=', 1)
            o[k] = v
        else:
            rest.append(x)
    return o, rest


class Dec:
    def __init__(self, params):
        self.out = []
        self.labels = []
        self.nparams = params

    def name(self, i):
        i = int(i)
        return f'a{i}' if i < self.nparams else f'v{i}'

    def addr(self, node):
        o, rest = opts(node)
        a = self.e(rest[0])
        off = o.get('offset')
        return f'{a}+{off}' if off else a

    def label(self, x):
        if x.startswith('@'):
            return x
        return self.labels[-1 - int(x)]

    def e(self, n):
        if isinstance(n, str):
            return n
        op = n[0]
        args = [x for x in n[1:]]
        if op.endswith('.const'):
            v = args[0]
            if op.startswith('i32'):
                iv = int(v, 0)
                return str(iv) if abs(iv) < 4096 else f'{iv}'
            return v
        if op == 'local.get':
            return self.name(args[0])
        if op == 'global.get':
            return f'g{args[0]}'
        if op == 'local.tee':
            return f'({self.name(args[0])} = {self.e(args[1])})'
        if op in LOADS:
            return f'{LOADS[op]}[{self.addr(n)}]'
        t, _, base = op.partition('.')
        if base in BIN:
            o = BIN[base]
            a, b = self.e(args[0]), self.e(args[1])
            if o.isalpha():
                return f'{o}({a}, {b})'
            return f'({a} {o} {b})'
        if base == 'eqz':
            return f'!{self.e(args[0])}'
        if op == 'select':
            a = [x for x in args if not (isinstance(x, list) and x and x[0] == 'result')]
            return f'({self.e(a[2])} ? {self.e(a[0])} : {self.e(a[1])})'
        if op == 'call':
            return f'f{args[0]}({", ".join(self.e(x) for x in args[1:])})'
        if op == 'call_indirect':
            a = [x for x in args if not (isinstance(x, list) and x and x[0] in ('type', 'param', 'result'))]
            return f'(*{self.e(a[-1])})({", ".join(self.e(x) for x in a[:-1])})'
        if base in ('extend_i32_u', 'extend_i32_s', 'wrap_i64', 'trunc_f32_s', 'trunc_f64_s', 'trunc_f32_u',
                    'trunc_f64_u', 'convert_i32_s', 'convert_i32_u', 'convert_i64_s', 'convert_i64_u', 'demote_f64',
                    'promote_f32', 'reinterpret_f32', 'reinterpret_f64', 'reinterpret_i32', 'reinterpret_i64',
                    'trunc_sat_f32_s', 'trunc_sat_f64_s', 'trunc_sat_f32_u', 'trunc_sat_f64_u', 'extend8_s', 'extend16_s'):
            return f'{t}.{base}({self.e(args[0])})'
        if base in ('abs', 'neg', 'sqrt', 'ceil', 'floor', 'trunc', 'nearest', 'clz', 'ctz', 'popcnt'):
            return f'{base}({self.e(args[0])})'
        if op in ('block', 'loop', 'if'):
            # an expression-valued block: print it as a statement, give a placeholder
            self.s(n, 0)
            return '<blockval>'
        if op == 'memory.size':
            return 'memsize'
        if op == 'memory.grow':
            return f'memgrow({self.e(args[0])})'
        return f'<{op} {" ".join(self.e(x) for x in args)}>'

    def w(self, d, s):
        self.out.append('  ' * d + s)

    def body(self, items, d):
        for x in items:
            if isinstance(x, list) and x and x[0] in ('result', 'type', 'param'):
                continue
            self.s(x, d)

    def s(self, n, d):
        if isinstance(n, str):
            self.w(d, n)
            return
        op, args = n[0], n[1:]
        if op in ('block', 'loop'):
            lab = f'@{len(self.labels) + 1}'
            self.labels.append(lab)
            self.w(d, f'{op} {lab} {{')
            self.body(args, d + 1)
            self.w(d, '}')
            self.labels.pop()
        elif op == 'if':
            lab = f'@{len(self.labels) + 1}'
            rest = [x for x in args if not (isinstance(x, list) and x and x[0] in ('result', 'type'))]
            cond = rest[0]
            then = next((x for x in rest if isinstance(x, list) and x[0] == 'then'), None)
            els = next((x for x in rest if isinstance(x, list) and x[0] == 'else'), None)
            self.labels.append(lab)
            self.w(d, f'if {lab} ({self.e(cond)}) {{')
            if then:
                self.body(then[1:], d + 1)
            if els:
                self.w(d, '} else {')
                self.body(els[1:], d + 1)
            self.w(d, '}')
            self.labels.pop()
        elif op == 'br':
            self.w(d, f'br {self.label(args[0])}' + (f' <- {self.e(args[1])}' if len(args) > 1 else ''))
        elif op == 'br_if':
            self.w(d, f'if ({self.e(args[-1])}) br {self.label(args[0])}')
        elif op == 'br_table':
            labs = [x for x in args if isinstance(x, str)]
            exprs = [x for x in args if isinstance(x, list)]
            self.w(d, f'switch ({self.e(exprs[-1])}) [{", ".join(self.label(x) for x in labs[:-1])}] default {self.label(labs[-1])}')
        elif op == 'local.set':
            self.w(d, f'{self.name(args[0])} = {self.e(args[1])}')
        elif op == 'global.set':
            self.w(d, f'g{args[0]} = {self.e(args[1])}')
        elif op in STORES:
            o, rest = opts(n)
            a = self.e(rest[0])
            off = o.get('offset')
            self.w(d, f'{STORES[op]}[{a}+{off}] = {self.e(rest[1])}' if off else f'{STORES[op]}[{a}] = {self.e(rest[1])}')
        elif op == 'return':
            self.w(d, 'return' + (f' {self.e(args[0])}' if args else ''))
        elif op == 'drop':
            self.w(d, self.e(args[0]))
        elif op == 'unreachable':
            self.w(d, 'unreachable')
        elif op in ('memory.fill', 'memory.copy'):
            self.w(d, f'{op}({", ".join(self.e(x) for x in args)})')
        else:
            self.w(d, self.e(n))


def main():
    wat, idx, *fs = sys.argv[1:]
    starts = {}
    for line in open(idx):
        a, b = line.split()
        starts[int(b)] = int(a)
    lines = open(wat, encoding='latin1').read().split('\n')
    for f in map(int, fs):
        s = starts[f] - 1
        e = starts.get(f + 1, s + 1) - 1
        if e <= s:
            e = s
            while e < len(lines) and not lines[e + 1].startswith('  ('):
                e += 1
            e += 1
        node = parse('\n'.join(lines[s:e]))[0]
        params = sum(len([y for y in x[1:] if not y.startswith('$')]) for x in node if isinstance(x, list) and x[0] == 'param')
        res = [x for x in node if isinstance(x, list) and x[0] == 'result']
        d = Dec(params)
        body = [x for x in node[1:] if not (isinstance(x, list) and x[0] in ('type', 'param', 'result', 'local'))]
        print(f'func f{f}({", ".join(f"a{i}" for i in range(params))}){" -> " + " ".join(res[0][1:]) if res else ""} {{')
        d.body(body, 1)
        print('\n'.join(d.out))
        print('}\n')


main()
