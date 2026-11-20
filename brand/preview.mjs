import { svg } from './mark.mjs'; import fs from 'fs';
fs.writeFileSync('/workspace/out/prev.svg', svg({ bg: '#0B0805', rounded: .2 }));
