import fs from 'node:fs';
import { processSvg } from '../src/sch-beautify-core';
const [, , inp, out] = process.argv;
const r = processSvg(fs.readFileSync(inp, 'utf8'));
fs.writeFileSync(out, r.svg);
const s = r.stats;
console.log(JSON.stringify({ seg: s.segments, H: s.H, V: s.V, diag: s.diagonal, cross: s.crossings, arcs: s.arcs, merged: s.merged, skipped: s.skipped.length, notes: s.notes.length, markers: s.markersRemoved, font: s.fontChanged, dots: s.dotsRecolored, conflicts: s.colorConflicts.length }));
