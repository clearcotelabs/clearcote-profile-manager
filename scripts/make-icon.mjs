// Rasterize the brand mark (public/icon.svg) into the two shapes electron-builder wants:
//   build/icon.ico — multi-size Windows icon (NSIS installer + the .exe itself)
//   build/icon.png — 512×512, what the Linux targets take (AppImage/desktop entry); anything
//                    under 256×256 is rejected outright, so this is deliberately generous.
// Run: npm run make-icon
import sharp from "sharp";
import pngToIco from "png-to-ico";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const svg = readFileSync(new URL("../public/icon.svg", import.meta.url));
mkdirSync(new URL("../build", import.meta.url), { recursive: true });

const render = (s) =>
  sharp(svg, { density: 512 })
    .resize(s, s, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(sizes.map(render));

const ico = await pngToIco(pngs);
writeFileSync(new URL("../build/icon.ico", import.meta.url), ico);
console.log(`wrote build/icon.ico (${ico.length} bytes, sizes ${sizes.join("/")})`);

const png = await render(512);
writeFileSync(new URL("../build/icon.png", import.meta.url), png);
console.log(`wrote build/icon.png (${png.length} bytes, 512×512)`);
