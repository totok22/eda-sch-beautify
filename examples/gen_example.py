#!/usr/bin/env python3
"""生成通用示例原理图 SVG（模仿嘉立创EDA专业版导出结构，内容为虚构）。"""
import itertools
ids = (f"{i:016x}" for i in itertools.count(0x1000))
W = "stroke-width:1;stroke:#008800;vector-effect:none;"
out = []
def wire(x1, y1, x2, y2):
    out.append(f'<polyline points="{x1} {y1} {x2} {y2}" id="{next(ids)}" data-group-id="w" c_partid="wire" style="{W}"/>')
def junc(x, y):
    out.append(f'<circle style="stroke-width:1;stroke:#CC0000;vector-effect:none;fill:#CC0000;" r="2.5" cx="{x}" cy="{y}" id="{next(ids)}"/>')
def nc(x, y):
    out.append(f'<circle style="stroke-width:1;stroke:#999999;vector-effect:none;fill:#999999B3;" r="1" cx="{x}" cy="{y}" id="{next(ids)}"/>')
def text(x, y, s, size=7, fill="#000080", anchor="start", cp=None):
    c = f' c_partid="{cp}"' if cp else ""
    out.append(f'<text style="font-family:\'Times New Roman\';font-size:{size}px;font-style:normal;font-weight:normal;fill:{fill};stroke:none;" id="{next(ids)}"{c} x="{x}" y="{y}" text-anchor="{anchor}" transform="rotate(0, {x}, {y})" dominant-baseline="ideographic"><tspan xml:space="preserve" x="{x}" dx="0" dy="0">{s}</tspan></text>')
def pin(x1, y1, x2, y2):
    out.append(f'<g id="{next(ids)}" c_partid="part_pin" noconnect="0"><path d="M {x1} {y1} L {x2} {y2}" style="stroke:#880000;fill:none;vector-effect:none;" class="pin-bar"/><ellipse cx="{x1}" cy="{y1}" rx="1" ry="1" style="stroke:#880000;fill:none;"/></g>')
def part(body, attrs):
    out.append('<g c_partid="part">'); out.extend(body); 
    for a in attrs: text(*a[:3], cp="part_attr")
    out.append('</g>')
def resistor(x, y, name, val):  # vertical, pins at y and y+40
    b = []
    out.append('<g c_partid="part">')
    out.append(f'<rect x="{x-4}" y="{y+10}" width="8" height="20" style="stroke:#880000;fill:none;stroke-width:1;"/>')
    pin(x, y, x, y + 10); pin(x, y + 40, x, y + 30)
    text(x + 7, y + 18, name, cp="part_attr"); text(x + 7, y + 27, val, cp="part_attr")
    out.append('</g>')

# 总线：三根水平线，被多根竖线穿过（不相连）
for y, name in [(60, "信号 CAN_H"), (72, "信号 CAN_L"), (84, "电源 VCC")]:
    wire(30, y, 330, y); text(32, y - 2, name, fill="#008800")
for x in (90, 130, 170):
    wire(x, 40, x, 130); resistor(x, 130, f"R{(x-50)//40}", "10kΩ")
    wire(x, 170, x, 180)
wire(80, 180, 180, 180); text(130, 192, "地 GND", fill="#008800", anchor="middle")
junc(130, 180); junc(90, 180)
# 竖线顶部未连接端
for x in (90, 130, 170): nc(x, 40)
# T 型连接（有节点，不应加跨线弧）
wire(220, 72, 220, 110); junc(220, 72)
wire(250, 60, 250, 120); junc(250, 60)
# 芯片
out.append('<g c_partid="part">')
out.append('<rect x="270" y="100" width="60" height="60" style="stroke:#880000;fill:#FFFFCC;stroke-width:1;"/>')
pin(250, 120, 270, 120); pin(220, 110, 240, 110)
text(300, 96, "U1", cp="part_attr", anchor="middle"); text(300, 172, "控制器 MCU", cp="part_attr", anchor="middle")
out.append('</g>')
wire(240, 110, 270, 110)
wire(330, 140, 360, 140); nc(360, 140); text(336, 137, "TX", fill="#008800")
wire(200, 40, 200, 150); nc(200, 40); nc(200, 150)   # 一根孤立竖线穿过三根总线

body = "".join(out)
print(f'<svg style="fill:transparent;" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="800" height="420" viewBox="10 20 400 210"><style> *{{stroke-linejoin: round;stroke-linecap: round}}</style>{body}</svg>')
