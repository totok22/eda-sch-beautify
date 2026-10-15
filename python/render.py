#!/usr/bin/env python3
"""Render SVG -> PNG with headless Chrome (same engine as browser/canvas). usage: render.py in.svg out.png [width]"""
import sys, re, subprocess, tempfile, os, pathlib
src, dst = sys.argv[1], sys.argv[2]; W = int(sys.argv[3]) if len(sys.argv) > 3 else 3000
svg = open(src, encoding='utf-8').read()
vb = [float(v) for v in re.search(r'viewBox="([^"]+)"', svg).group(1).split()]
H = round(W * vb[3] / vb[2])
d = tempfile.mkdtemp()
html = pathlib.Path(d, 'p.html')
html.write_text('<html><body style="margin:0;background:#fff"><img src="%s" style="display:block;width:%dpx;height:%dpx"></body></html>'
                % (pathlib.Path(os.path.abspath(src)).as_uri(), W, H))
subprocess.run(['google-chrome', '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
                '--allow-file-access-from-files', '--force-device-scale-factor=1',
                '--window-size=%d,%d' % (W, H), '--screenshot=' + os.path.abspath(dst), html.as_uri()],
               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print(dst, W, H)
