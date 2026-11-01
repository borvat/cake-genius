/**
 * Generates the catalog artwork as local SVG files (no external image CDN, so
 * the app works offline and the CSP can stay strict).
 * Run: node tools/gen-images.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const out = path.join(process.cwd(), 'public', 'img');
fs.mkdirSync(out, { recursive: true });

const P = {
  celebrate: { bg: ['#fff4e6', '#ffd9b5'], body: ['#fdf4e6', '#e8c8a4'], frost: '#f7d9b4', accent: '#e07a5f', drip: '#fff9f0', deco: 'sprinkles' },
  choco: { bg: ['#f6ece4', '#dcc3b0'], body: ['#6e4029', '#3d2116'], frost: '#3f2418', accent: '#d8a276', drip: '#5c3625', deco: 'shards' },
  redvelvet: { bg: ['#ffefee', '#ffcbc6'], body: ['#9c2f2a', '#6b1a18'], frost: '#fdf4ee', accent: '#c0392b', drip: '#fff8f3', deco: 'crumbs' },
  pistachio: { bg: ['#f2f7ea', '#cfe3bd'], body: ['#eaf0d3', '#a8c184'], frost: '#fbfcee', accent: '#7f9e4f', drip: '#f8fbea', deco: 'pistachio' },
  lotus: { bg: ['#fcf1e1', '#eccb9f'], body: ['#c07f3d', '#94561f'], frost: '#fdf1de', accent: '#8a4b1f', drip: '#ffefd6', deco: 'biscoff' },
  mango: { bg: ['#fffaea', '#ffdf8f'], body: ['#ffc94d', '#e79b16'], frost: '#fffaf0', accent: '#e08e00', drip: '#fffdf4', deco: 'mango' },
  kids: { bg: ['#eaf3ff', '#ffd0e7'], body: ['#fffafc', '#ffcfe3'], frost: '#ffd166', accent: '#4a90e2', drip: '#fff5fa', deco: 'sprinkles' },
  wedding: { bg: ['#fbf6f3', '#e9d9ce'], body: ['#fffdfb', '#eedfd2'], frost: '#ffffff', accent: '#c48b9f', drip: '#fffaf6', deco: 'roses' },
  corporate: { bg: ['#ecf0f6', '#c9d1de'], body: ['#2c3846', '#141b26'], frost: '#3d4c5e', accent: '#a8b8c9', drip: '#2b3543', deco: 'logo' },
  mini: { bg: ['#fff6ee', '#ffdcc0'], body: ['#ffe8d0', '#efc199'], frost: '#fffbf5', accent: '#d97b4a', drip: '#fffdf9', deco: 'minis' },
};

const rnd = (seed) => () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);

function sprinkles(a) {
  const colors = [a, '#f4a261', '#2a9d8f', '#e76f51', '#8e7dbe', '#ffd166'];
  const r = rnd(11);
  let s = '';
  for (let i = 0; i < 22; i++) {
    const ang = r() * Math.PI * 2;
    const rad = r() * 112;
    const x = 400 + Math.cos(ang) * rad;
    const y = 214 + Math.sin(ang) * rad * 0.19;
    s += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="13" height="4.5" rx="2.2" fill="${colors[i % colors.length]}" transform="rotate(${Math.round(r() * 180)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
  }
  return s;
}

function shards(a) {
  let s = '';
  for (let i = 0; i < 8; i++) {
    const x = 292 + i * 31;
    const h = 34 + (i % 3) * 16;
    s += `<path d="M${x} 206 l14 -${h} l13 ${h} z" fill="${a}" opacity="0.9" transform="rotate(${i % 2 ? -10 : 8} ${x + 13} ${206 - h / 2})"/>`;
  }
  return s;
}

function crumbs(a) {
  const r = rnd(23);
  let s = '';
  for (let i = 0; i < 16; i++) {
    s += `<circle cx="${(300 + r() * 200).toFixed(1)}" cy="${(200 + r() * 28).toFixed(1)}" r="${(2 + r() * 3).toFixed(1)}" fill="${a}" opacity="0.5"/>`;
  }
  return s;
}

function pistachio(a) {
  const r = rnd(31);
  let s = '';
  for (let i = 0; i < 13; i++) {
    const x = 305 + r() * 190;
    const y = 200 + r() * 24;
    s += `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="6.5" ry="9" fill="${a}" opacity="0.85" transform="rotate(${Math.round(r() * 60 - 30)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
  }
  return s;
}

function biscoff(a) {
  let s = '';
  for (let i = 0; i < 5; i++) {
    const x = 305 + i * 40;
    s += `<g transform="rotate(${i % 2 ? -16 : 11} ${x + 15} 190)">
      <rect x="${x}" y="152" width="30" height="48" rx="5" fill="${a}"/>
      <rect x="${x + 5}" y="159" width="20" height="34" rx="3" fill="#f6e5cf" opacity="0.55"/>
    </g>`;
  }
  return s;
}

function mango(a) {
  let s = '';
  for (let i = 0; i < 6; i++) {
    const x = 300 + i * 36;
    s += `<path d="M${x} 208 q17 -30 34 0 z" fill="${i % 2 ? '#ffb703' : a}" opacity="0.95"/>
          <path d="M${x + 4} 208 q13 -18 26 0 z" fill="#fff2c4" opacity="0.85"/>`;
  }
  return s;
}

function logo(a) {
  return `<g transform="translate(400 196)" opacity="0.95">
    <rect x="-56" y="-24" width="112" height="48" rx="10" fill="none" stroke="${a}" stroke-width="3"/>
    <path d="M-28 0 h56" stroke="${a}" stroke-width="3" stroke-linecap="round"/>
    <circle cx="0" cy="0" r="10" fill="${a}"/>
  </g>`;
}

function roses(a) {
  const pos = [[300, 214], [352, 202], [406, 208], [460, 200], [508, 216], [378, 186], [434, 190]];
  return pos.map(([x, y], i) => `<g transform="translate(${x} ${y})">
      <circle r="17" fill="${i % 2 ? '#f8ebec' : a}"/>
      <circle r="11" fill="${i % 2 ? a : '#fff7f8'}" opacity="0.92"/>
      <circle r="5" fill="#e6c4ca"/>
    </g>`).join('') +
    `<path d="M300 224 q-22 20 -14 40" stroke="#84a05a" stroke-width="3.5" fill="none" opacity="0.7"/>
     <path d="M460 226 q24 16 18 38" stroke="#84a05a" stroke-width="3.5" fill="none" opacity="0.7"/>`;
}

function minis(a) {
  let s = '';
  const xs = [262, 342, 422, 502];
  xs.forEach((x, i) => {
    const h = 74 + (i % 2) * 26;
    const top = 400 - h;
    s += `<ellipse cx="${x + 38}" cy="${400}" rx="52" ry="10" fill="#c9a887" opacity="0.45"/>
          <path d="M${x} ${top + 12} L${x + 76} ${top + 12} L${x + 70} 400 L${x + 6} 400 Z" fill="${i % 2 ? '#fff8ef' : a}"/>
          <ellipse cx="${x + 38}" cy="${top + 12}" rx="38" ry="12" fill="#fffdf8"/>
          <ellipse cx="${x + 38}" cy="${top + 12}" rx="30" ry="8" fill="${i % 2 ? '#ffe6d1' : '#fff'}"/>
          <circle cx="${x + 30}" cy="${top + 8}" r="5" fill="#e07a5f"/>
          <circle cx="${x + 48}" cy="${top + 10}" r="4" fill="#7f9e4f"/>`;
  });
  return s;
}

const DECO = { sprinkles, shards, crumbs, pistachio, biscoff, mango, logo, roses, minis };

function cakeBody(id, p) {
  return `
    <path d="M258 232 L542 232 L542 412 Q400 448 258 412 Z" fill="url(#body-${id})"/>
    <path d="M258 232 L542 232 L542 412 Q400 448 258 412 Z" fill="url(#side-${id})"/>
    <ellipse cx="400" cy="232" rx="142" ry="30" fill="${p.frost}"/>
    <ellipse cx="400" cy="231" rx="142" ry="28" fill="url(#top-${id})"/>
    <path d="M258 232
             c0 18 26 30 46 26 c16 -3 22 12 40 12 c20 0 24 -14 44 -14 c20 0 26 16 46 16 c18 0 24 -16 42 -16 c20 0 24 14 46 14 c18 0 24 -16 20 -38 Z"
          fill="${p.drip}" opacity="0.96"/>
    <path d="M258 232 q142 -34 284 0" fill="none" stroke="#00000014" stroke-width="2"/>`;
}

function layers() {
  return `<path d="M262 300 q138 26 276 0" fill="none" stroke="#ffffff" stroke-width="2.5" opacity="0.22"/>
          <path d="M262 356 q138 24 276 0" fill="none" stroke="#ffffff" stroke-width="2.5" opacity="0.16"/>`;
}

function svg(key, p) {
  const id = key;
  const deco = (DECO[p.deco] || (() => ''))(p.accent);
  const isMini = p.deco === 'minis';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600" role="img">
  <defs>
    <linearGradient id="bg-${id}" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="${p.bg[0]}"/><stop offset="1" stop-color="${p.bg[1]}"/>
    </linearGradient>
    <linearGradient id="body-${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${p.body[0]}"/><stop offset="1" stop-color="${p.body[1]}"/>
    </linearGradient>
    <linearGradient id="side-${id}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#000000" stop-opacity="0.16"/>
      <stop offset="0.4" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.12"/>
    </linearGradient>
    <radialGradient id="top-${id}" cx="42%" cy="35%" r="70%">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.9"/>
      <stop offset="1" stop-color="${p.frost}" stop-opacity="1"/>
    </radialGradient>
    <radialGradient id="vignette-${id}" cx="50%" cy="40%" r="65%">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.8"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="800" height="600" fill="url(#bg-${id})"/>
  <rect width="800" height="600" fill="url(#vignette-${id})"/>
  <ellipse cx="400" cy="446" rx="186" ry="26" fill="#4a3126" opacity="0.13"/>
  <ellipse cx="400" cy="442" rx="140" ry="16" fill="#4a3126" opacity="0.1"/>
  ${isMini
    ? `<ellipse cx="400" cy="404" rx="215" ry="22" fill="#efe0cf"/>
       ${deco}`
    : `<ellipse cx="400" cy="424" rx="176" ry="26" fill="#f3e6d7"/>
       <ellipse cx="400" cy="420" rx="176" ry="24" fill="#fdf7ef"/>
       <g transform="translate(400 330) scale(1.44) translate(-400 -330)">
         ${cakeBody(id, p)}
         ${layers()}
       </g>
       ${deco}`}
</svg>
`;
}

for (const [key, cfg] of Object.entries(P)) {
  fs.writeFileSync(path.join(out, `${key}.svg`), svg(key, cfg), 'utf8');
  console.log('wrote', key + '.svg');
}
