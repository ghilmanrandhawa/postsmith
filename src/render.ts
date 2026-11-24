import sharp from "sharp";

export const PLATFORMS = {
  instagram: { label: "Instagram", width: 1080, height: 1080, captionLimit: 2200 },
  linkedin: { label: "LinkedIn", width: 1200, height: 627, captionLimit: 3000 },
  x: { label: "X", width: 1200, height: 675, captionLimit: 280 },
} as const;
export type Platform = keyof typeof PLATFORMS;

export const THEMES = {
  sunset: { from: "#ff7a59", to: "#ffb347", text: "#1d1206", accent: "#ffffff" },
  ocean: { from: "#0f4c81", to: "#2bb3c0", text: "#ffffff", accent: "#d6f6ff" },
  forest: { from: "#1f4d3a", to: "#6aa84f", text: "#ffffff", accent: "#e8f5d9" },
  mono: { from: "#111111", to: "#3a3a3a", text: "#ffffff", accent: "#f2c94c" },
} as const;
export type Theme = keyof typeof THEMES;

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

/** Greedy word wrap by an approximate character budget per line. */
function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "") + "…";
  }
  return lines;
}

export interface CardInput {
  platform: Platform;
  theme: Theme;
  headline: string;
  subline: string;
  brand?: string;
}

/** Renders the post visual as SVG (used for the in-chat preview and as the PNG source). */
export function renderSvg({ platform, theme, headline, subline, brand = "Postsmith" }: CardInput): string {
  const { width: w, height: h } = PLATFORMS[platform];
  const t = THEMES[theme];
  const pad = Math.round(w * 0.08);
  const headSize = Math.round(Math.min(w, h) * (platform === "instagram" ? 0.085 : 0.075));
  const headLines = wrap(headline, Math.floor((w - pad * 2) / (headSize * 0.52)), 4);
  const subSize = Math.round(headSize * (platform === "instagram" ? 0.42 : 0.52));
  const subLines = wrap(subline, Math.floor((w - pad * 2) / (subSize * 0.5)), 2);
  const blockHeight = headLines.length * headSize * 1.12 + 24 + subLines.length * subSize * 1.35;
  let y = (h - blockHeight) / 2 + headSize;
  const head = headLines
    .map((l, i) => `<text x="${pad}" y="${(y + i * headSize * 1.12).toFixed(0)}" font-size="${headSize}" font-weight="800" fill="${t.text}">${escapeXml(l)}</text>`)
    .join("");
  y += (headLines.length - 1) * headSize * 1.12 + 24 + subSize * 1.35;
  const sub = subLines
    .map((l, i) => `<text x="${pad}" y="${(y + i * subSize * 1.35).toFixed(0)}" font-size="${subSize}" font-weight="500" fill="${t.text}" opacity="0.85">${escapeXml(l)}</text>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Helvetica, Arial, sans-serif">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.from}"/><stop offset="1" stop-color="${t.to}"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/>
<circle cx="${w * 0.88}" cy="${h * 0.12}" r="${Math.min(w, h) * 0.22}" fill="${t.accent}" opacity="0.12"/>
<rect x="${pad}" y="${pad * 0.8}" width="${headSize * 1.2}" height="${Math.max(6, headSize * 0.12)}" rx="4" fill="${t.accent}"/>
${head}${sub}
<text x="${pad}" y="${h - pad * 0.6}" font-size="${Math.round(subSize * 0.8)}" font-weight="700" fill="${t.text}" opacity="0.7" letter-spacing="2">${escapeXml(brand.toUpperCase())}</text>
</svg>`;
}

export const renderPng = (card: CardInput) => sharp(Buffer.from(renderSvg(card))).png().toBuffer();
