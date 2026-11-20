// Regenerate every FREYA brand asset from mark.mjs.  node brand/build.mjs  (then rasterise with the jobs file)
import fs from 'fs'; import path from 'path';
import { svg, BG, GOLD, ringPath, boldPath, innerPath, ticksPath, fPath, SLIT } from './mark.mjs';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = '/tmp/freya-brand'; fs.mkdirSync(tmp, { recursive: true });
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const jobs = [];
const png = (name, opts, out, size) => { const f = `${tmp}/${name}.svg`; w(f, svg(opts)); jobs.push([f, out, size]); };

// ---- web ----
w(`${root}/mark.svg`, svg({}));                                         // transparent mark (lock, wrap, splash)
w(`${root}/icon.svg`, svg({ bg: BG, rounded: .22, scale: .9 }));        // favicon / any-purpose
png('icon', { bg: BG, rounded: .22, scale: .9 }, `${root}/icon-192.png`, 192);
png('icon', { bg: BG, rounded: .22, scale: .9 }, `${root}/icon-512.png`, 512);
png('maskable', { bg: BG, scale: .78 }, `${root}/icon-maskable-512.png`, 512);
png('apple', { bg: BG, scale: .86 }, `${root}/apple-touch-icon.png`, 180);
png('fav', { bg: BG, rounded: .22, scale: .95, mono: true }, `${root}/favicon-32.png`, 32);

// ---- Android launcher ----
const res = `${root}/android/app/src/main/res`;
const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, m] of Object.entries(dens)) {
  png('fg', { scale: .78 }, `${res}/mipmap-${d}/ic_launcher_fg.png`, Math.round(108 * m));
  png('legacy', { bg: BG, rounded: .22, scale: .9 }, `${res}/mipmap-${d}/ic_launcher.png`, Math.round(48 * m));
}
w(`${res}/mipmap-anydpi/ic_launcher.xml`, `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/bg"/>
  <foreground android:drawable="@mipmap/ic_launcher_fg"/>
  <monochrome android:drawable="@drawable/ic_launcher_mono"/>
</adaptive-icon>
`);
w(`${res}/mipmap-anydpi/ic_launcher_round.xml`, fs.readFileSync(`${res}/mipmap-anydpi/ic_launcher.xml`, 'utf8'));

// Vector drawables (viewport = the 512 mark frame, scaled around the centre)
const grp = (s, body) => `  <group android:pivotX="256" android:pivotY="256" android:scaleX="${s}" android:scaleY="${s}">\n${body}  </group>\n`;
const sp = (d, wdt, extra = '') => `    <path android:pathData="${d}" android:strokeColor="#FFFFFFFF" android:strokeWidth="${wdt}"${extra}/>\n`;
const fp = d => `    <path android:pathData="${d}" android:fillColor="#FFFFFFFF"/>\n`;
const vec = (dp, body) => `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="${dp}dp" android:height="${dp}dp" android:viewportWidth="512" android:viewportHeight="512">
${body}</vector>
`;
// Themed (Android 13+) icon: same geometry as the foreground, solid strokes
w(`${res}/drawable/ic_launcher_mono.xml`, vec(108, grp(.78,
  sp(ringPath(), 5) + sp(boldPath(), 9) + sp(ticksPath(), 10) + sp(fPath(), 7, ' android:strokeLineJoin="miter"'))));
// Status bar / Quick Settings tile: tiny, so the F is solid
w(`${res}/drawable/ic_stat.xml`, vec(24, grp(1.3,
  sp(ringPath(), 16) + sp(ticksPath(), 24) + fp(fPath()))));

// ---- Splash (Android 12+): the ring draws itself in around the F ----
const anim = (target, prop, from, to, dur, delay = 0) => `  <target android:name="${target}"><aapt:attr name="android:animation">
    <objectAnimator android:propertyName="${prop}" android:valueFrom="${from}" android:valueTo="${to}" android:valueType="floatType" android:duration="${dur}" android:startOffset="${delay}" android:interpolator="@android:interpolator/fast_out_slow_in"/>
  </aapt:attr></target>\n`;
const G = '#FFE8B45A';
w(`${res}/drawable/splash_anim.xml`, `<?xml version="1.0" encoding="utf-8"?>
<animated-vector xmlns:android="http://schemas.android.com/apk/res/android" xmlns:aapt="http://schemas.android.com/aapt">
  <aapt:attr name="android:drawable">
    <vector android:width="288dp" android:height="288dp" android:viewportWidth="512" android:viewportHeight="512">
      <group android:name="mark" android:pivotX="256" android:pivotY="256" android:scaleX=".86" android:scaleY=".86">
        <group android:name="spin" android:pivotX="256" android:pivotY="256" android:rotation="-90">
          <path android:name="ring" android:pathData="M256,80A176,176 0 1 1 256,432A176,176 0 1 1 256,80" android:strokeColor="${G}" android:strokeWidth="2.5" android:trimPathEnd="0"/>
          <path android:name="bold" android:pathData="${boldPath()}" android:strokeColor="${G}" android:strokeWidth="4.5" android:strokeAlpha="0"/>
          <path android:name="inner" android:pathData="${innerPath()}" android:strokeColor="${G}" android:strokeWidth="1.6" android:strokeAlpha="0"/>
        </group>
        <path android:name="ticks" android:pathData="${ticksPath()}" android:strokeColor="${G}" android:strokeWidth="5" android:strokeAlpha="0"/>
        <path android:name="f" android:pathData="${fPath()}" android:strokeColor="#FFFFD98F" android:strokeWidth="3" android:strokeLineJoin="miter" android:fillColor="#1AE8B45A" android:trimPathEnd="0"/>
        <path android:name="glare" android:pathData="M120,256L390,256" android:strokeColor="#FFFFF3D6" android:strokeWidth="1.4" android:strokeAlpha="0"/>
      </group>
    </vector>
  </aapt:attr>
${anim('ring', 'trimPathEnd', 0, 1, 650)}${anim('spin', 'rotation', -90, 0, 900)}${anim('bold', 'strokeAlpha', 0, 1, 300, 450)}${anim('inner', 'strokeAlpha', 0, .75, 300, 550)}${anim('ticks', 'strokeAlpha', 0, 1, 250, 350)}${anim('f', 'trimPathEnd', 0, 1, 600, 200)}${anim('glare', 'strokeAlpha', 0, .9, 250, 700)}</animated-vector>
`);
fs.writeFileSync(`${tmp}/jobs.json`, JSON.stringify(jobs));
console.log(jobs.length + ' rasters queued -> ' + tmp + '/jobs.json');
