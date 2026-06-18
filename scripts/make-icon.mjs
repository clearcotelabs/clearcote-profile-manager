// Rasterize the brand mark (public/icon.svg) into a multi-size Windows .ico
// for electron-builder (build/icon.ico). Run: npm run make-icon
import sharp from "sharp";
import pngToIco from "png-to-ico";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const svg = readFileSync(new URL("../public/icon.svg", import.meta.url));
mkdirSync(new URL("../build", import.meta.url), { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(
  sizes.map((s) => sharp(svg, { density: 512 }).resize(s, s, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()),
);

const ico = await pngToIco(pngs);
writeFileSync(new URL("../build/icon.ico", import.meta.url), ico);
console.log(`wrote build/icon.ico (${ico.length} bytes, sizes ${sizes.join("/")})`);
