// Procedural artwork for the demo community: landscape "photos" and avatars.
// Everything is drawn from code, so the demo contains no real people, places, or photos.
import sharp from 'sharp';

export function random(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function ridge(rand, { y, amp, rough = 1, w = 1600, h = 1000 }) {
  const waves = [0.6, 1.4, 3.1, 6.8, 15, 33].map((cycles, i) => ({ f: cycles * rough * (0.85 + rand() * 0.3) / w * Math.PI * 2, a: amp * [1, 0.55, 0.28, 0.12, 0.05, 0.02][i], p: rand() * Math.PI * 2 }));
  const pts = [];
  for (let x = 0; x <= w; x += 8) pts.push(`${x},${(y - waves.reduce((t, v) => t + v.a * Math.sin(x * v.f + v.p), 0)).toFixed(1)}`);
  return `M0,${h} L${pts.join(' L')} L${w},${h} Z`;
}
const band = (id, color, peak) => `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops([[0, color, 0], [0.5, color, peak], [1, color, 0]])}</linearGradient>`;
const stops = (list) => list.map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join('');
export const scenes = {
  dawn(seed = 3) {
    const r = random(seed);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">${stops([[0, '#1d1b3f'], [0.38, '#5b3a6e'], [0.62, '#d9776a'], [0.8, '#f6b47a']])}</linearGradient>
<radialGradient id="sun" cx="0.63" cy="0.6" r="0.45">${stops([[0, '#fff1c9', 1], [0.08, '#ffd59a', 0.95], [0.3, '#f59e6c', 0.35], [1, '#f59e6c', 0]])}</radialGradient>
${band('haze', '#f8c48c', 0.5)}</defs>
<rect width="1600" height="1000" fill="url(#sky)"/><rect width="1600" height="1000" fill="url(#sun)"/>
<path d="${ridge(r, { y: 640, amp: 70, rough: 1.2 })}" fill="#b4677a"/><rect y="500" width="1600" height="300" fill="url(#haze)"/>
<path d="${ridge(r, { y: 700, amp: 90, rough: 1.5 })}" fill="#7e4669"/>
<path d="${ridge(r, { y: 780, amp: 80, rough: 2 })}" fill="#4d2f55"/>
<path d="${ridge(r, { y: 880, amp: 60, rough: 2.6 })}" fill="#24183a"/></svg>`;
  },
  mist(seed = 11) {
    const r = random(seed);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">${stops([[0, '#9fb7c4'], [0.6, '#dfe6e3'], [1, '#eef0e8']])}</linearGradient>
${band('fog', '#eef1ec', 0.92)}</defs>
<rect width="1600" height="1000" fill="url(#sky)"/>
<path d="${ridge(r, { y: 520, amp: 120, rough: 1 })}" fill="#8aa0a6"/><rect y="390" width="1600" height="280" fill="url(#fog)"/>
<path d="${ridge(r, { y: 640, amp: 110, rough: 1.4 })}" fill="#5d7a77"/><rect y="520" width="1600" height="280" fill="url(#fog)"/>
<path d="${ridge(r, { y: 780, amp: 90, rough: 2.2 })}" fill="#36564f"/><rect y="660" width="1600" height="240" fill="url(#fog)" opacity="0.6"/>
<path d="${ridge(r, { y: 900, amp: 50, rough: 3 })}" fill="#1f3a33"/></svg>`;
  },
  lake(seed = 5) {
    const r = random(seed);
    const far = ridge(r, { y: 470, amp: 110, rough: 1.1 }), mid = ridge(r, { y: 540, amp: 70, rough: 1.8 });
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">${stops([[0, '#4f86c6'], [0.55, '#a9cbe8'], [1, '#e3eef5']])}</linearGradient>
<linearGradient id="water" x1="0" y1="0" x2="0" y2="1">${stops([[0, '#6f9fc7'], [1, '#22476a']])}</linearGradient>
<clipPath id="above"><rect width="1600" height="600"/></clipPath><clipPath id="below"><rect y="600" width="1600" height="400"/></clipPath></defs>
<rect width="1600" height="1000" fill="url(#sky)"/>
<g clip-path="url(#above)"><path d="${far}" fill="#7f9bb5"/><path d="${mid}" fill="#3f6b5b"/></g>
<rect y="600" width="1600" height="400" fill="url(#water)"/>
<g clip-path="url(#below)" opacity="0.35"><g transform="translate(0,1200) scale(1,-1)"><path d="${far}" fill="#7f9bb5"/><path d="${mid}" fill="#3f6b5b"/></g></g>
${Array.from({ length: 26 }, () => `<rect x="${(r() * 1600).toFixed(0)}" y="${(610 + r() * 380).toFixed(0)}" width="${(40 + r() * 160).toFixed(0)}" height="2" fill="#ffffff" opacity="${(0.15 + r() * 0.25).toFixed(2)}"/>`).join('')}
<path d="M0,600 L1600,600 L1600,612 L0,618 Z" fill="#2c5446"/></svg>`;
  },
  night(seed = 21) {
    const r = random(seed);
    const pine = (x, base, hgt) => { const w = hgt * 0.32; return Array.from({ length: 4 }, (_, i) => { const t = base - i * hgt * 0.22, ww = w * (1 - i * 0.2); return `M${x - ww},${t} L${x},${t - hgt * 0.42} L${x + ww},${t} Z`; }).join(' '); };
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">${stops([[0, '#070b1f'], [0.65, '#18275a'], [1, '#3a3f7a']])}</linearGradient>
<linearGradient id="band" x1="0" y1="0" x2="1" y2="1">${stops([[0, '#9fb4ff', 0], [0.5, '#c9d4ff', 0.22], [1, '#9fb4ff', 0]])}</linearGradient>
<filter id="blur" filterUnits="userSpaceOnUse" x="-400" y="-400" width="2400" height="1800"><feGaussianBlur stdDeviation="40"/></filter><filter id="glow"><feGaussianBlur stdDeviation="1.2"/></filter></defs>
<rect width="1600" height="1000" fill="url(#sky)"/>
<path d="M-300,900 C400,520 1000,260 1950,-260 L1950,0 C1000,500 450,760 -300,1120 Z" fill="url(#band)" filter="url(#blur)"/>
<g filter="url(#glow)">${Array.from({ length: 420 }, () => `<circle cx="${(r() * 1600).toFixed(0)}" cy="${(r() * 760).toFixed(0)}" r="${(r() ** 3 * 2.4 + 0.5).toFixed(2)}" fill="#ffffff" opacity="${(0.4 + r() * 0.6).toFixed(2)}"/>`).join('')}</g>
<path d="${ridge(r, { y: 820, amp: 60, rough: 1.5 })}" fill="#0d1230"/>
<path d="${Array.from({ length: 22 }, (_, i) => pine(i * 76 + r() * 30, 1000 - r() * 40, 150 + r() * 160)).join(' ')}" fill="#05081a"/>
<rect y="950" width="1600" height="50" fill="#05081a"/>
<circle cx="980" cy="905" r="26" fill="#ffb15a" opacity="0.18" filter="url(#blur)"/><path d="M955,960 L980,915 L1005,960 Z" fill="#f2a24a" opacity="0.9"/></svg>`;
  },
};
// Grain keeps flat gradients from looking synthetic.
export async function photo(svg, { quality = 86 } = {}) {
  const base = await sharp(Buffer.from(svg)).png().toBuffer();
  const grain = await sharp({ create: { width: 1600, height: 1000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 18 } } }).png().toBuffer();
  return sharp(base).composite([{ input: grain, blend: 'soft-light' }]).jpeg({ quality, mozjpeg: true }).toBuffer();
}

// Agents get geometric glyphs; people get soft silhouettes, so the two read differently at a glance.
export const avatars = {
  atlas: () => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#0f172a"/></linearGradient></defs>
<rect width="512" height="512" fill="url(#g)"/><g fill="none" stroke="#89b4fa" stroke-width="14"><circle cx="256" cy="256" r="150"/><ellipse cx="256" cy="256" rx="150" ry="58"/><ellipse cx="256" cy="256" rx="58" ry="150"/></g><circle cx="256" cy="256" r="26" fill="#cdd6f4"/></svg>`,
  nova: () => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><defs><radialGradient id="g" cx="0.5" cy="0.5" r="0.7"><stop offset="0" stop-color="#4c1d95"/><stop offset="1" stop-color="#1a1033"/></radialGradient></defs>
<rect width="512" height="512" fill="url(#g)"/><path d="M256 86 L292 220 L426 256 L292 292 L256 426 L220 292 L86 256 L220 220 Z" fill="#cba6f7"/><circle cx="256" cy="256" r="34" fill="#f5e0ff"/></svg>`,
  orbit: () => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0f3d3a"/><stop offset="1" stop-color="#0b1f1e"/></linearGradient><linearGradient id="p" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a6e3a1"/><stop offset="1" stop-color="#40a02b"/></linearGradient></defs>
<rect width="512" height="512" fill="url(#g)"/><circle cx="256" cy="256" r="110" fill="url(#p)"/><ellipse cx="256" cy="262" rx="200" ry="52" fill="none" stroke="#94e2d5" stroke-width="16" transform="rotate(-18 256 262)"/><circle cx="398" cy="150" r="18" fill="#f9e2af"/></svg>`,
  person: (from, to, skin) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
<rect width="512" height="512" fill="url(#g)"/><circle cx="256" cy="210" r="92" fill="${skin}" opacity="0.92"/><path d="M96 512 C110 380 180 330 256 330 C332 330 402 380 416 512 Z" fill="${skin}" opacity="0.92"/></svg>`,
};
export async function avatar(svg) { return sharp(Buffer.from(svg)).png().toBuffer(); }
