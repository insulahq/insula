#!/usr/bin/env python3
"""Audit UI surfaces that do not use, or do not honour, @insula/api-contracts.

Two questions, answered separately because they have different remedies:

  (1) NOT USING the contracts — a hook that declares its own request/response
      shape. tsc then checks that shape against its own caller and nothing
      else, so backend drift is invisible. This is exact and complete.

  (2) NOT HONOURING them — a mutation that sends a key the backend does not
      accept. This is a real, live defect. Detection is PARTIAL: it can only
      compare a call when both the sent keys and the accepted keys are
      statically recoverable. The script prints its own coverage; treat a
      clean run as "nothing found in the covered slice", never as "clean".

Validated against a known live bug: the admin panel sent tenant_id /
tenant_secret to POST /admin/oidc/providers, which requires client_id /
client_secret (0000_tenant_rename.sql renamed the column, 0001 reverted it,
the panel's hand-written copy never followed). This script flags it.
"""
import re, sys, pathlib, collections

ROOT = pathlib.Path(__file__).resolve().parent.parent

def named_shapes():
    """name -> keys, for every zod object and interface in backend + contracts."""
    out = collections.defaultdict(set)
    for f in list(ROOT.glob('packages/api-contracts/src/*.ts')) + list(ROOT.glob('backend/src/**/*.ts')):
        src = f.read_text(errors='ignore')
        for m in re.finditer(r'(?:export\s+)?const\s+(\w+)\s*=\s*z\.object\(\{(.*?)\n\}\)', src, re.S):
            out[m.group(1)] |= set(re.findall(r'^\s{2}([a-zA-Z_]\w*)\s*:', m.group(2), re.M))
        for m in re.finditer(r'(?:export\s+)?interface\s+(\w+)\s*\{(.*?)\n\}', src, re.S):
            out[m.group(1)] |= set(re.findall(r'^\s{2}(?:readonly\s+)?([a-zA-Z_]\w*)\??\s*:', m.group(2), re.M))
    return out

def backend_routes(shapes):
    routes = []
    for f in ROOT.glob('backend/src/modules/*/routes*.ts'):
        src = f.read_text(errors='ignore')
        for m in re.finditer(r"app\.(post|put|patch|delete)\(\s*'([^']+)'", src):
            start = m.end()
            nxt = re.search(r"\n  app\.(get|post|put|patch|delete)\(", src[start:])
            seg = src[start:start + (nxt.start() if nxt else 4000)]
            keys, via = set(), None
            sm = re.search(r'(\w+Schema)\.(?:safe)?[Pp]arse\(\s*(?:request|req)\.body', seg)
            if sm and sm.group(1) in shapes:
                keys, via = shapes[sm.group(1)], f'schema:{sm.group(1)}'
            else:
                cm = re.search(r'(?:request|req)\.body as (?:unknown as )?(?:Partial<)?(\w+)', seg)
                if cm and cm.group(1) in shapes:
                    keys, via = shapes[cm.group(1)], f'cast:{cm.group(1)}'
            routes.append({'method': m.group(1).upper(), 'path': m.group(2),
                           'keys': keys, 'via': via, 'file': str(f.relative_to(ROOT))})
    return routes

def main():
    shapes = named_shapes()
    routes = backend_routes(shapes)

    # ── (1) hooks not using the contracts ────────────────────────────────────
    local_req, local_resp, hook_files, importing = collections.Counter(), collections.Counter(), 0, 0
    fe_shapes = {}
    contract_imports = collections.defaultdict(set)
    for f in sorted(ROOT.glob('frontend/*/src/**/*.ts')):
        src = f.read_text(errors='ignore')
        for m in re.finditer(r'(?:export\s+)?interface\s+(\w+)\s*\{(.*?)\n\}', src, re.S):
            ks = set(re.findall(r'^\s{2}(?:readonly\s+)?([a-zA-Z_]\w*)\??\s*:', m.group(2), re.M))
            if ks: fe_shapes[(str(f), m.group(1))] = ks
        for m in re.finditer(r"import type \{([^}]*)\} from '@insula/api-contracts'", src):
            contract_imports[str(f)] |= {t.strip() for t in m.group(1).split(',') if t.strip()}
        if f.match('frontend/*/src/hooks/*.ts'):
            hook_files += 1
            if '@insula/api-contracts' in src: importing += 1
            for m in re.finditer(r'^(?:export )?(?:interface|type) (\w*(?:Input|Request|Payload))\b', src, re.M):
                if not re.search(rf'type {m.group(1)} = [A-Z]\w*;', src):
                    local_req[f.name] += 1
            for m in re.finditer(r'^(?:export )?interface (\w*(?:Response|Result))\b', src, re.M):
                local_resp[f.name] += 1

    # ── (2) mutations sending keys the backend rejects ───────────────────────
    def route_for(method, path):
        fp = re.sub(r':\w+', ':p', re.sub(r'^/api/v1', '', path))
        cand = [r for r in routes if r['method'] == method and re.sub(r':\w+', ':p', r['path']) == fp]
        for r in cand:
            if r['keys']: return r
        return cand[0] if cand else None

    compared, drift = 0, []
    for f in sorted(ROOT.glob('frontend/*/src/**/*.ts')):
        src = f.read_text(errors='ignore')
        for m in re.finditer(r"mutationFn:\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*"
                             r"apiFetch<[^>]*>\(\s*[`'\"](.*?)[`'\"]\s*,\s*\{(.{0,700}?)\}\s*,?\s*\)", src, re.S):
            params, path, opts = m.group(1), m.group(2), m.group(3)
            mm = re.search(r"method:\s*'(\w+)'", opts)
            if not mm or mm.group(1).upper() == 'GET': continue
            method = mm.group(1).upper()
            lit = re.search(r'body:\s*JSON\.stringify\(\s*\{(.*?)\}\s*\)', opts, re.S)
            var = re.search(r'body:\s*JSON\.stringify\(\s*(\w+)\s*\)', opts)
            if lit:
                sent = set(re.findall(r'(?:^|,)\s*([a-zA-Z_]\w*)\s*[:,\n]', lit.group(1)))
            elif var:
                tm = re.search(re.escape(var.group(1)) + r'\s*:\s*(?:Partial<)?(\w+)', params)
                if not tm or tm.group(1) in contract_imports[str(f)]: continue
                sent = fe_shapes.get((str(f), tm.group(1)), set())
            else:
                continue
            if not sent: continue
            r = route_for(method, re.sub(r'\$\{[^}]+\}', ':p', path))
            if not r or not r['keys']: continue
            compared += 1
            extra = sorted(sent - r['keys'])
            if extra:
                drift.append((str(f.relative_to(ROOT)), method, path, extra, r))

    total_mut = sum(1 for r in routes)
    print('── API-contract drift audit ────────────────────────────────────────')
    print(f'\n(1) UI surfaces NOT USING the contracts  [exact]')
    print(f'    hook files ............................ {hook_files}')
    print(f'    importing @insula/api-contracts ....... {importing}')
    print(f'    NOT importing ......................... {hook_files - importing}')
    print(f'    locally-declared REQUEST shapes ....... {sum(local_req.values())} in {len(local_req)} files')
    print(f'    locally-declared RESPONSE shapes ...... {sum(local_resp.values())} in {len(local_resp)} files')
    if local_req:
        print('    most request shapes:')
        for n, c in local_req.most_common(6): print(f'      {c:2}  {n}')

    print(f'\n(2) Mutations NOT HONOURING the contracts  [PARTIAL — see coverage]')
    print(f'    backend mutating routes ............... {total_mut}')
    print(f'    …with a statically recoverable shape .. {sum(1 for r in routes if r["keys"])}')
    print(f'    frontend mutations compared ........... {compared}')
    print(f'    sending an unaccepted key ............. {len(drift)}')
    for file, method, path, extra, r in drift:
        print(f'\n      {file}')
        print(f'        {method} {path}')
        print(f'        sends but backend rejects: {", ".join(extra)}')
        print(f'        backend accepts via {r["via"]} ({r["file"]})')

    print(f'\n    COVERAGE: {compared} of {total_mut} mutating routes were actually compared.')
    print( '    A clean section (2) means "nothing found in that slice", NOT "no drift".')
    return 1 if drift else 0

if __name__ == '__main__':
    sys.exit(main())
