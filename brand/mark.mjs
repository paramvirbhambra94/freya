// FREYA mark: angled outlined F inside a HUD targeting ring. Single source of truth for
// the web orb, PWA icons, Android launcher/monochrome/notification icons and splash.
// Geometry lives in a 512x512 frame centred on (256,256).
export const C = 256;
export const R = 176;            // main ring
export const RI = 163;           // inner arcs
export const TICK = [160, 190];  // cardinal ticks (inner, outer radius)
export const GOLD = '#E8B45A', GOLD_HI = '#FFD98F', BG = '#0B0805';
// F outline (clockwise), chamfered corners, nudged left to sit optically centred.
const FX = -10;
export const F = [[218.5,177.5],[347.5,177.5],[318.5,206.5],[239,206.5],[228.5,217],[228.5,242.5],[316,242.5],[287.5,271.5],[239,271.5],[228.5,282],[228.5,327.5],[195,364.5],[195,199]]
  .map(([x, y]) => [+(x + FX).toFixed(1), y]);
export const fPath = (pts = F) => 'M' + pts.map(p => p.join(',')).join('L') + 'Z';
// Slit across the stem (the angled "cut" in the reference) - [x1,y1,x2,y2]
export const SLIT = [178 + FX, 296, 214 + FX, 260];

const rad = d => (d - 90) * Math.PI / 180;
const pt = (r, d) => [+(C + r * Math.cos(rad(d))).toFixed(2), +(C + r * Math.sin(rad(d))).toFixed(2)];
export function arc(r, a0, a1) { const [x0, y0] = pt(r, a0), [x1, y1] = pt(r, a1); return `M${x0},${y0}A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1},${y1}`; }
const quad = f => [0, 90, 180, 270].map(q => f(q)).join('');
// ring split into 4 arcs leaving small gaps where the ticks cross
export const ringPath = () => quad(q => arc(R, q + 3, q + 87));
export const boldPath = () => quad(q => arc(R, q + 36, q + 57));
export const innerPath = () => quad(q => arc(RI, q + 33, q + 60) + arc(RI, q + 23, q + 26.5) + arc(RI, q + 66.5, q + 70));
export const ticksPath = () => [0, 90, 180, 270].map(d => { const [a, b] = pt(TICK[0], d), [c, e] = pt(TICK[1], d); return `M${a},${b}L${c},${e}`; }).join('');

// ---- full SVG (web + raster source) ----
// opts: bg (fill colour or null), rounded (corner radius as fraction), scale (mark scale around centre),
// glow (bool), mono (single colour, no glow, chunkier strokes for tiny sizes), color
export function svg({ size = 512, bg = null, rounded = 0, scale = 1, glow = true, mono = false, color = GOLD } = {}) {
  const k = mono ? 1.5 : 1;
  const tf = `translate(${C} ${C}) scale(${scale}) translate(${-C} ${-C})`;
  const g = glow ? ' filter="url(#gl)"' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
<defs>
<filter id="gl" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<linearGradient id="ff" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".10"/><stop offset="1" stop-color="${color}" stop-opacity=".02"/></linearGradient>
<filter id="gs" x="-10%" y="-400%" width="120%" height="900%"><feGaussianBlur stdDeviation="2.5"/></filter><linearGradient id="gz" x1="0" x2="1"><stop offset="0" stop-color="${GOLD_HI}" stop-opacity="0"/><stop offset=".35" stop-color="#FFF3D6" stop-opacity=".95"/><stop offset="1" stop-color="${GOLD_HI}" stop-opacity="0"/></linearGradient>
<mask id="cut"><rect width="512" height="512" fill="#fff"/><path d="M${SLIT[0]},${SLIT[1]}L${SLIT[2]},${SLIT[3]}" stroke="#000" stroke-width="${3.5 * k}"/></mask>
</defs>
${bg ? `<rect width="512" height="512" rx="${512 * rounded}" fill="${bg}"/>` : ''}
<g transform="${tf}" fill="none" stroke="${color}" stroke-linecap="butt">
<g${g}>
<path d="${ringPath()}" stroke-width="${2 * k}" opacity="${mono ? 1 : .85}"/>
<path d="${boldPath()}" stroke-width="${4.2 * k}"/>
${mono ? '' : `<path d="${innerPath()}" stroke-width="1.4" opacity=".75"/>`}
<path d="${ticksPath()}" stroke-width="${5 * k}"/>
<g mask="url(#cut)"><path d="${fPath()}" ${mono ? '' : 'fill="url(#ff)"'} stroke-width="${(mono ? 2.4 : 2.6) * k}" stroke-linejoin="miter"/></g>
</g>
${mono ? '' : `<g filter="url(#gs)"><rect x="110" y="254.6" width="290" height="2.8" fill="url(#gz)"/></g><rect x="150" y="255.4" width="190" height="1.2" fill="url(#gz)"/><circle cx="212" cy="256" r="1.8" fill="#FFF7E6"/>`}
</g>
</svg>`;
}
