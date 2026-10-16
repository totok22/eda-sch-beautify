#!/usr/bin/env python3
"""
eda_sch_beautify.py - 给嘉立创EDA专业版(EasyEDA Pro)导出的原理图 SVG 在"不相连的导线交叉处"加半圆跨线弧。

识别规则（基于实测导出）:
  导线    <polyline c_partid="wire" points="x1 y1 x2 y2 ...">
  节点    实心 <circle>（默认 #CC0000, r=2.5）
  引脚端  空心 <ellipse>，引脚 c_partid="part_pin"
只改动有交叉的导线元素（polyline -> path，保留 id/data-*/style），其余内容原样输出。
"""
import re, math, argparse
from collections import Counter
from lxml import etree

SVGNS = 'http://www.w3.org/2000/svg'
TOL = 1e-3

# ---------------- geometry helpers ----------------
def mat_mul(a, b):
    return (a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
            a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5])
I = (1, 0, 0, 1, 0, 0)

def parse_transform(s):
    m = I
    for name, args in re.findall(r'(\w+)\s*\(([^)]*)\)', s or ''):
        v = [float(t) for t in re.split(r'[\s,]+', args.strip()) if t]
        if name == 'matrix': t = tuple(v)
        elif name == 'translate': t = (1, 0, 0, 1, v[0], v[1] if len(v) > 1 else 0)
        elif name == 'scale': t = (v[0], 0, 0, v[1] if len(v) > 1 else v[0], 0, 0)
        elif name == 'rotate':
            c, s_ = math.cos(math.radians(v[0])), math.sin(math.radians(v[0]))
            t = (c, s_, -s_, c, 0, 0)
            if len(v) == 3:
                t = mat_mul(mat_mul((1, 0, 0, 1, v[1], v[2]), t), (1, 0, 0, 1, -v[1], -v[2]))
        else: continue
        m = mat_mul(m, t)
    return m

def ctm(el):
    m = I; chain = []
    while el is not None and isinstance(el.tag, str):
        chain.append(el); el = el.getparent()
    for e in reversed(chain): m = mat_mul(m, parse_transform(e.get('transform')))
    return m

def apply(m, p): return (m[0]*p[0]+m[2]*p[1]+m[4], m[1]*p[0]+m[3]*p[1]+m[5])
def inverse(m):
    d = m[0]*m[3]-m[1]*m[2]
    a, b, c, e = m[3]/d, -m[1]/d, -m[2]/d, m[0]/d
    return (a, b, c, e, -(a*m[4]+c*m[5]), -(b*m[4]+e*m[5]))

def fmt(n): return ('%.3f' % n).rstrip('0').rstrip('.')
def q(v): return round(v / TOL) * TOL

def style_get(el, key):
    m = re.search(r'(?<![-\w])%s:\s*([^;]+)' % key, el.get('style', ''))
    return m.group(1).strip() if m else el.get(key)

def set_color(el, col):
    st = el.get('style', '')
    for k in ('stroke', 'fill'):
        if re.search(r'(?<![-\w])%s:' % k, st): st = re.sub(r'(?<![-\w])%s:\s*[^;]+' % k, k + ':' + col, st)
        else: st += '%s:%s;' % (k, col)
    el.set('style', st)

CJK = r'[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]'
CJK_RUN = re.compile(r'(%s+)' % CJK)

def apply_color_theme(root, theme):
    """black-on-white / white-on-black: recolor stroke & fill to one color. Leaves defs/mask/pattern/clipPath contents
    (white there is a mask's "visible" signal), fill/stroke none|transparent|currentColor|url(...) alone; with black-on-white
    white fills stay white. Mirrors applyColorTheme() in extension/src/sch-beautify-core.ts. Returns elements touched."""
    bow = theme == 'black-on-white'; target = '#000000' if bow else '#FFFFFF'
    white = re.compile(r'^(#fff|#ffffff|white|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))$')
    skip = ('defs', 'mask', 'pattern', 'clipPath')
    def keep(c, is_fill):
        c = c.strip().lower()
        return c in ('none', 'transparent', 'currentcolor') or c.startswith('url(') or (is_fill and bow and bool(white.match(c)))
    def restyle(st):
        st = re.sub(r'(?<![-\w])stroke:\s*([^;"]+)', lambda m: m.group(0) if keep(m.group(1), False) else 'stroke:' + target, st)
        return re.sub(r'(?<![-\w])fill:\s*([^;"]+)', lambda m: m.group(0) if keep(m.group(1), True) else 'fill:' + target, st)
    n = 0
    for el in root.iter():
        if not isinstance(el.tag, str): continue
        if etree.QName(el).localname in skip or any(isinstance(p.tag, str) and etree.QName(p).localname in skip for p in el.iterancestors()): continue
        touched = False
        if el.get('style'):
            ns = restyle(el.get('style'))
            if ns != el.get('style'): el.set('style', ns); touched = True
        for k in ('stroke', 'fill'):
            v = el.get(k)
            if v is not None and not keep(v, k == 'fill') and v != target: el.set(k, target); touched = True
        n += touched
    return n

def split_cjk(text_el, font):
    """wrap CJK runs of every text node inside text_el in <tspan style="font-family:font">; returns runs wrapped"""
    n = 0
    def mk(run):
        e = etree.Element('{%s}tspan' % SVGNS); e.set('style', 'font-family:%s;' % font); e.text = run; return e
    for el in list(text_el.iter()):
        if el.get('data-cjk') == '1': continue
        # el.text
        if el.text and re.search(CJK, el.text):
            parts = CJK_RUN.split(el.text); el.text = parts[0]
            pos = 0
            for i in range(1, len(parts), 2):
                sp = mk(parts[i]); sp.set('data-cjk', '1'); sp.tail = parts[i + 1]
                el.insert(pos, sp); pos += 1; n += 1
        # tails of children (skip the ones we just made: their tails are plain text)
        for ch in list(el):
            if ch.get('data-cjk') == '1': continue
            if ch.tail and re.search(CJK, ch.tail):
                parts = CJK_RUN.split(ch.tail); ch.tail = parts[0]
                idx = list(el).index(ch) + 1
                for i in range(1, len(parts), 2):
                    sp = mk(parts[i]); sp.set('data-cjk', '1'); sp.tail = parts[i + 1]
                    el.insert(idx, sp); idx += 1; n += 1
    return n

# ---------------- main ----------------
def main():
    ap = argparse.ArgumentParser(description='Add semicircle hop-overs to EasyEDA Pro schematic SVG.',
                                 formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    ap.add_argument('inp', help='input SVG (EasyEDA Pro export)')
    ap.add_argument('out', help='output SVG')
    ap.add_argument('--hop', choices=['horizontal', 'vertical', 'auto'], default='horizontal',
                    help='which wire draws the arc. horizontal: bump up (KiCad style); vertical: bump right; auto: minimise arc count')
    ap.add_argument('--r', type=float, default=None, help='arc radius in SVG units (default: 3 x wire stroke width, min 2)')
    ap.add_argument('--min-r', type=float, default=1.2, help='smallest allowed radius after shrinking')
    ap.add_argument('--gap', type=float, default=1.0, help='min straight wire between two arcs / before a segment end')
    ap.add_argument('--close', choices=['shrink', 'merge'], default='shrink',
                    help='close crossings: shrink = equal smaller arcs (KiCad look), merge = one long arc')
    ap.add_argument('--junction-color', choices=['wire', 'keep'], default='wire', help='recolor junction dots to wire color')
    ap.add_argument('--exclude-rect', action='append', default=[], metavar='x,y,w,h',
                    help='no arcs inside this rect (SVG/viewBox coords); repeatable')
    ap.add_argument('--keep-end-markers', action='store_true',
                    help='keep the gray "unconnected wire end" markers (default: remove them)')
    ap.add_argument('--font', default="SimSun, 宋体, 'Songti SC', 'Noto Serif CJK SC', serif",
                    help='font-family applied to text elements that contain Chinese')
    ap.add_argument('--font-mode', choices=['split', 'element'], default='split',
                    help='split: wrap only Chinese runs in <tspan> with --font (Latin keeps original font); element: set font on whole text element')
    ap.add_argument('--keep-font', action='store_true', help='do not change any font')
    ap.add_argument('--axis-tol', type=float, default=0.5,
                    help='treat a segment as horizontal/vertical if it deviates less than this (EasyEDA sometimes exports 0.1-0.4 off-axis wires)')
    ap.add_argument('--keep-background', action='store_true',
                    help='keep a full-page background <rect> / root background style if the export has one (default: remove)')
    ap.add_argument('--no-avoid', action='store_true', help='do not shrink arcs that touch dots/pins/text')
    ap.add_argument('--color-theme', choices=['default', 'black-on-white', 'white-on-black'], default='default',
                    help='recolor every line / text / fill to one color (same as the extension panel option); the output has no background, add one when using white-on-black')
    a = ap.parse_args()
    excl = [tuple(map(float, s.split(','))) for s in a.exclude_rect]

    tree = etree.parse(a.inp); root = tree.getroot()
    # --- page background (some exports/themes add a full-page filled <rect> or root background) ---
    bg_removed = 0
    def is_light_fill(f):
        f = (f or '').strip().lower()
        if f in ('#fff', '#ffffff', '#fffcf8', '#fafafa', '#f5f4ef', '#fdfdfd', '#fcfcfc', '#f5f5f5'): return True
        if f.startswith('#') and len(f) == 7:
            try:
                r, g, b = int(f[1:3], 16), int(f[3:5], 16), int(f[5:7], 16)
                return r >= 235 and g >= 235 and b >= 220
            except ValueError: pass
        if f.startswith('rgb'):
            nums = [int(n) for n in re.findall(r'\d+', f)]
            if len(nums) >= 3: return nums[0] >= 235 and nums[1] >= 235 and nums[2] >= 220
        return False

    if not a.keep_background:
        vb = [float(v) for v in re.split(r'[\s,]+', root.get('viewBox', '0 0 0 0').strip())]
        st = root.get('style', '')
        if re.search(r'background(-color)?\s*:', st):
            root.set('style', re.sub(r'background(-color)?\s*:[^;]*;?', '', st)); bg_removed += 1
        for r in list(root.iter('{*}rect')):
            if any(isinstance(p.tag, str) and etree.QName(p).localname in ('defs', 'pattern', 'mask', 'clipPath', 'symbol') for p in r.iterancestors()): continue
            fill = (style_get(r, 'fill') or 'black').strip().lower()
            if fill in ('none', 'transparent') or fill.startswith('url('): continue
            partid = r.get('c_partid', '')
            rid = r.get('id', '')
            rcls = r.get('class', '')
            if partid in ('part', 'part_pin', 'part_attr', 'wire'): continue
            try: x, y, w, h = (float(r.get(k, 0)) for k in ('x', 'y', 'width', 'height'))
            except ValueError: continue
            is_sheet = bool(re.search(r'sheet|frame|background|page', f'{partid} {rid} {rcls}', re.I))
            # only an un-outlined light plate counts as sheet background; outlined rects are user-drawn group/module boxes
            stroke = (style_get(r, 'stroke') or 'none').strip().lower()
            is_plate = vb[2] > 0 and stroke in ('none', 'transparent') and is_light_fill(fill) and w * h >= 0.5 * vb[2] * vb[3]
            if is_sheet or is_plate or (vb[2] > 0 and w * h >= 0.8 * vb[2] * vb[3]):
                r.getparent().remove(r); bg_removed += 1
    wires = [e for e in root.iter('{*}polyline') if e.get('c_partid') == 'wire']

    # segments in global coords
    segs = []; diag = 0; wm = {}
    for w in wires:
        m = ctm(w); wm[id(w)] = m
        v = [float(t) for t in re.split(r'[\s,]+', (w.get('points') or '').strip()) if t]
        P = [apply(m, p) for p in zip(v[0::2], v[1::2])]
        P = [(q(x), q(y)) for x, y in P]
        sw = float(re.sub('[^0-9.]', '', style_get(w, 'stroke-width') or '1') or 1)
        for i in range(len(P) - 1):
            p, r_ = P[i], P[i + 1]
            if p == r_: continue
            kind = 'h' if abs(p[1]-r_[1]) <= a.axis_tol else 'v' if abs(p[0]-r_[0]) <= a.axis_tol else 'd'
            if kind == 'd': diag += 1
            segs.append(dict(el=w, i=i, p=p, q=r_, kind=kind, sw=sw, col=style_get(w, 'stroke')))
    ends = Counter((s['p']) for s in segs) + Counter((s['q']) for s in segs)

    # --- unconnected wire-end markers: gray <circle> (stroke #999999, fill #999999xx) on a wire end ---
    deg = Counter(); 
    for sg in segs: deg[sg['p']] += 1; deg[sg['q']] += 1
    markers = []; marker_els = set()
    for c in root.iter('{*}circle'):
        st = (c.get('style', '') + ';' + (c.get('stroke') or '') + (c.get('fill') or '')).lower()
        if re.search(r'stroke:\s*#999999\b', st) and re.search(r'fill:\s*#999999', st):
            cx, cy = apply(ctm(c), (float(c.get('cx', 0)), float(c.get('cy', 0))))
            near = [p for p in deg if math.hypot(p[0]-cx, p[1]-cy) < .6]
            markers.append((c, cx, cy, bool(near) and all(deg[p] == 1 for p in near)))
            marker_els.add(c)
    removed_markers = []
    if not a.keep_end_markers:
        for c, cx, cy, ok in markers:
            c.getparent().remove(c); removed_markers.append((cx, cy, ok))

    # --- Chinese text -> SimSun ---
    fontinfo = dict(changed=0, total=0, orig=Counter())
    for t in root.iter('{*}text'):
        fontinfo['total'] += 1
        fam = style_get(t, 'font-family') or '(none)'
        fontinfo['orig'][fam] += 1
        if a.keep_font: continue
        txt = ''.join(t.itertext())
        if a.font_mode == 'split' and re.search(CJK, txt):
            fontinfo['changed'] += split_cjk(t, a.font) and 1
            continue
        if re.search(CJK, txt) or \
           re.search(r'(宋|黑|楷|仿宋|SimSun|SimHei|YaHei|Song|Hei|Kai|CJK)', fam, re.I):
            st = t.get('style', '')
            if re.search(r'font-family:', st): st = re.sub(r'font-family:\s*[^;]+', 'font-family:' + a.font, st)
            else: st += 'font-family:%s;' % a.font
            t.set('style', st); t.attrib.pop('font-family', None); fontinfo['changed'] += 1

    # obstacles
    dots = []
    for c in root.iter('{*}circle'):
        st = c.get('style', '') + (c.get('fill') or '')
        if 'fill:none' in st or 'fill:transparent' in st or c in marker_els: continue
        cx, cy = apply(ctm(c), (float(c.get('cx', 0)), float(c.get('cy', 0))))
        dots.append((c, cx, cy, float(c.get('r', 2))))
    pinpts = []
    for e in root.iter('{*}ellipse'):
        cx, cy = apply(ctm(e), (float(e.get('cx', 0)), float(e.get('cy', 0))))
        pinpts.append((cx, cy, float(e.get('rx', 2))))
    texts = []   # rough bbox estimate: anchor + font-size; heuristic only
    for t in root.iter('{*}text'):
        try: x, y = float(t.get('x')), float(t.get('y'))
        except (TypeError, ValueError): continue
        fs = float(re.sub('[^0-9.]', '', style_get(t, 'font-size') or '7') or 7)
        L = len(''.join(t.itertext())) * fs * 0.55
        anc = t.get('text-anchor', 'start')
        x0 = x - L if anc == 'end' else x - L/2 if anc == 'middle' else x
        texts.append((x0, y - fs, x0 + L, y))   # dominant-baseline=ideographic -> text above y

    # --- junction colour ---
    jinfo = dict(recolored=0, conflicts=[], orphan=0)
    if a.junction_color == 'wire':
        for c, cx, cy, cr in dots:
            cols = []
            for s in segs:
                (x0, x1), (y0, y1) = sorted((s['p'][0], s['q'][0])), sorted((s['p'][1], s['q'][1]))
                if s['kind'] == 'h' and abs(cy - y0) < .5 and x0 - .5 <= cx <= x1 + .5 or \
                   s['kind'] == 'v' and abs(cx - x0) < .5 and y0 - .5 <= cy <= y1 + .5:
                    cols.append(s['col'])
            if not cols: jinfo['orphan'] += 1; continue
            cnt = Counter(cols)
            if len(cnt) > 1: jinfo['conflicts'].append((cx, cy, dict(cnt)))
            set_color(c, cnt.most_common(1)[0][0]); jinfo['recolored'] += 1

    # --- crossings ---
    H = [s for s in segs if s['kind'] == 'h']; V = [s for s in segs if s['kind'] == 'v']
    cross = []; skipped = []
    for h in H:
        y = (h['p'][1] + h['q'][1]) / 2; x0, x1 = sorted((h['p'][0], h['q'][0]))
        for v in V:
            x = (v['p'][0] + v['q'][0]) / 2; y0, y1 = sorted((v['p'][1], v['q'][1]))
            if not (x0 + TOL < x < x1 - TOL and y0 + TOL < y < y1 - TOL): continue
            if any(math.hypot(x-e[0], y-e[1]) < max(a.axis_tol, TOL*10) for e in (h['p'], h['q'], v['p'], v['q'])): skipped.append((x, y, 'T/endpoint')); continue
            if any(math.hypot(x-cx, y-cy) <= cr + .5 for _, cx, cy, cr in dots):
                skipped.append((x, y, 'junction dot')); continue
            if any(ex <= x <= ex+ew and ey <= y <= ey+eh for ex, ey, ew, eh in excl):
                skipped.append((x, y, 'excluded rect')); continue
            cross.append((x, y, h, v))

    def base_r(seg): return a.r if a.r is not None else max(2.0, 3 * seg['sw'])

    def clear_r(seg, t, r):
        """shrink r so the arc's bounding box avoids dots / pin ends / text. returns (r, reason)"""
        if a.no_avoid: return r, None
        hz = seg['kind'] == 'h'; fixed = seg['p'][1] if hz else seg['p'][0]
        reason = None
        while r >= a.min_r:
            if hz: bx = (t - r, fixed - r - .5, t + r, fixed - .2)
            else:  bx = (fixed + .2, t - r, fixed + r + .5, t + r)
            hit = None
            for _, cx, cy, cr in dots:
                if bx[0]-cr < cx < bx[2]+cr and bx[1]-cr < cy < bx[3]+cr: hit = 'dot'; break
            if not hit:
                for cx, cy, cr in pinpts:
                    if bx[0]-cr < cx < bx[2]+cr and bx[1]-cr < cy < bx[3]+cr: hit = 'pin'; break
            if not hit:
                for tx0, ty0, tx1, ty1 in texts:
                    if bx[0] < tx1 and tx0 < bx[2] and bx[1] < ty1 and ty0 < bx[3]: hit = 'text'; break
            if not hit: return r, reason
            reason = hit; r -= 0.25
        return None, reason

    def plan(assign):
        per = {}
        for k, (x, y, h, v) in enumerate(cross):
            seg, t = (h, x) if assign[k] == 'h' else (v, y)
            per.setdefault(id(seg), (seg, []))[1].append((t, k))
        arcs = []; skip = []; notes = []
        for seg, lst in per.values():
            ax = 0 if seg['kind'] == 'h' else 1
            p, qq = seg['p'], seg['q']; s = 1 if qq[ax] > p[ax] else -1
            R = base_r(seg)
            lst = sorted(set(lst), key=lambda e: s * e[0])
            # cluster crossings whose arcs would collide at full radius
            groups = []
            for t, k in lst:
                if groups and s * (t - groups[-1][-1][0]) < 2 * R + a.gap: groups[-1].append((t, k))
                else: groups.append([(t, k)])
            cur = p[ax]
            for gi, g in enumerate(groups):
                nxt = groups[gi+1][0][0] if gi + 1 < len(groups) else qq[ax]
                lim_end = min(s*(g[0][0]-cur), s*(nxt-g[-1][0]) - (R if gi+1 < len(groups) else 0)) - a.gap
                if len(g) > 1:
                    pitch = min(s*(g[j+1][0]-g[j][0]) for j in range(len(g)-1))
                    rs = (pitch - a.gap) / 2
                else: rs = R
                if a.close == 'shrink' and len(g) > 1 and rs >= a.min_r:
                    r = min(R, rs, lim_end)
                    if r < a.min_r: skip += [k for _, k in g]; continue
                    rr = r
                    for t, k in g:
                        c, why = clear_r(seg, t, rr)
                        if c is None: notes.append((k, why)); continue
                        rr = min(rr, c)
                    for t, k in g: arcs.append(dict(seg=seg, ta=t - s*rr, tb=t + s*rr, rx=rr, ry=rr, ks=[k], merged=False))
                    if rr < R: notes += [(k, 'shrunk to %s' % fmt(rr)) for _, k in g]
                    cur = g[-1][0] + s*rr
                else:
                    r = min(R, lim_end)
                    if r < a.min_r: skip += [k for _, k in g]; continue
                    for t, k in g:
                        c, why = clear_r(seg, t, r)
                        if c is not None and c < r: r = c; notes.append((k, 'shrunk (%s)' % why))
                        elif c is None: notes.append((k, 'touches %s' % why))
                    ta, tb = g[0][0] - s*r, g[-1][0] + s*r
                    arcs.append(dict(seg=seg, ta=ta, tb=tb, rx=abs(tb-ta)/2, ry=r, ks=[k for _, k in g], merged=len(g) > 1))
                    cur = tb
        return arcs, skip, notes

    cost = lambda asg: (lambda r: len(r[0]) + 10*len(r[1]))(plan(asg))
    n = len(cross)
    if a.hop == 'auto':
        asg = ['h']*n; best = cost(asg); moves = [[k] for k in range(n)]
        byv = {}
        for k, c in enumerate(cross): byv.setdefault(id(c[3]), []).append(k)
        moves += [ks for ks in byv.values() if len(ks) > 1]
        improved = True
        while improved:
            improved = False
            for ks in moves:
                tr = asg[:]
                for k in ks: tr[k] = 'v' if tr[k] == 'h' else 'h'
                c = cost(tr)
                if c < best: asg, best, improved = tr, c, True
    else:
        asg = ['h' if a.hop == 'horizontal' else 'v'] * n
    arcs, skipk, notes = plan(asg)
    for k in skipk: skipped.append((cross[k][0], cross[k][1], 'no room (near corner/end)'))

    # --- rebuild touched wires (in their local coordinates) ---
    byel = {}
    for arc in arcs: byel.setdefault(id(arc['seg']['el']), []).append(arc)
    for w in wires:
        if id(w) not in byel: continue
        m = wm[id(w)]; inv = inverse(m)
        my = [s for s in segs if s['el'] is w]
        loc = lambda P: apply(inv, P)
        d = 'M%s %s' % tuple(map(fmt, loc(my[0]['p'])))
        for seg in my:
            sa = sorted([x for x in byel[id(w)] if x['seg'] is seg], key=lambda x: x['ta'] * (1 if (seg['q'][0 if seg['kind']=='h' else 1] > seg['p'][0 if seg['kind']=='h' else 1]) else -1))
            hz = seg['kind'] == 'h'; ax = 0 if hz else 1
            s = 1 if seg['q'][ax] > seg['p'][ax] else -1
            pt = (lambda t: (t, (seg['p'][1]+seg['q'][1])/2)) if hz else (lambda t: ((seg['p'][0]+seg['q'][0])/2, t))
            for arc in sa:
                A, B = loc(pt(arc['ta'])), loc(pt(arc['tb']))
                sweep = (1 if s > 0 else 0) if hz else (0 if s > 0 else 1)
                if m[0]*m[3] - m[1]*m[2] < 0: sweep ^= 1
                rx, ry = (arc['rx'], arc['ry']) if hz else (arc['ry'], arc['rx'])
                d += ' L%s %s A%s %s 0 0 %d %s %s' % (fmt(A[0]), fmt(A[1]), fmt(rx), fmt(ry), sweep, fmt(B[0]), fmt(B[1]))
            d += ' L%s %s' % tuple(map(fmt, loc(seg['q'])))
        path = etree.Element('{%s}path' % SVGNS)
        for k, v in w.attrib.items():
            if k != 'points': path.set(k, v)
        path.set('d', d); path.set('data-hopover', '1')
        if 'fill' not in path.get('style', ''): path.set('style', path.get('style', '') + 'fill:none;')
        path.tail = w.tail
        w.getparent().replace(w, path)
    themed = apply_color_theme(root, a.color_theme) if a.color_theme != 'default' else 0
    tree.write(a.out, encoding='utf-8', xml_declaration=False)

    # --- summary ---
    merged = [x for x in arcs if x['merged']]
    print('== hopover summary (%s, close=%s, r=%s) ==' % (a.hop, a.close, fmt(a.r) if a.r else 'auto(3x stroke)'))
    print('wire segments: %d (H %d, V %d, diagonal ignored %d)' % (len(segs), len(H), len(V), diag))
    print('crossings: %d   arcs drawn: %d   merged arcs: %d (covering %d crossings)' %
          (n, len(arcs), len(merged), sum(len(x['ks']) for x in merged)))
    print('h-assigned %d, v-assigned %d' % (asg.count('h'), asg.count('v')))
    print('skipped: %d' % len(skipped))
    for x, y, why in skipped: print('  (%s, %s) %s' % (fmt(x), fmt(y), why))
    print('notes (shrunk / obstacles): %d' % len(notes))
    for k, why in notes: print('  (%s, %s) %s' % (fmt(cross[k][0]), fmt(cross[k][1]), why))
    print('page background elements removed: %d' % bg_removed)
    if a.color_theme != 'default': print('color theme %s: %d elements recolored' % (a.color_theme, themed))
    print('end markers found: %d, removed: %d%s' % (len(markers), len(removed_markers),
          '' if all(ok for *_, ok in removed_markers) else '  (not on a wire end, e.g. unconnected pin): ' +
          str([(fmt(x), fmt(y)) for x, y, ok in removed_markers if not ok])))
    print('text: %d, Chinese-font changed: %d, original font-family: %s' %
          (fontinfo['total'], fontinfo['changed'], dict(fontinfo['orig'])))
    if a.junction_color == 'wire':
        print('junction dots recolored: %d/%d, orphan %d, color conflicts %d' %
              (jinfo['recolored'], len(dots), jinfo['orphan'], len(jinfo['conflicts'])))
        for cx, cy, cnt in jinfo['conflicts']: print('  conflict (%s, %s) %s' % (fmt(cx), fmt(cy), cnt))

if __name__ == '__main__':
    main()
