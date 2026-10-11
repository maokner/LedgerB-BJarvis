/** Draws a plain receipt PNG with a 5x7 bitmap font, so the live vision test needs no image tools. */
import { crc32, deflateSync } from "node:zlib";

const FONT: Record<string, string[]> = {
  A: [" ### ", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
  B: ["#### ", "#   #", "#   #", "#### ", "#   #", "#   #", "#### "],
  C: [" ####", "#    ", "#    ", "#    ", "#    ", "#    ", " ####"],
  E: ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#####"],
  F: ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#    "],
  H: ["#   #", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
  I: ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "#####"],
  L: ["#    ", "#    ", "#    ", "#    ", "#    ", "#    ", "#####"],
  M: ["#   #", "## ##", "# # #", "# # #", "#   #", "#   #", "#   #"],
  N: ["#   #", "##  #", "# # #", "# # #", "#  ##", "#   #", "#   #"],
  O: [" ### ", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  P: ["#### ", "#   #", "#   #", "#### ", "#    ", "#    ", "#    "],
  R: ["#### ", "#   #", "#   #", "#### ", "# #  ", "#  # ", "#   #"],
  S: [" ####", "#    ", "#    ", " ### ", "    #", "    #", "#### "],
  T: ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  "],
  U: ["#   #", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  X: ["#   #", "#   #", " # # ", "  #  ", " # # ", "#   #", "#   #"],
  "0": [" ### ", "#   #", "#  ##", "# # #", "##  #", "#   #", " ### "],
  "1": ["  #  ", " ##  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
  "2": [" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"],
  "3": ["#####", "   # ", "  #  ", "   # ", "    #", "#   #", " ### "],
  "4": ["   # ", "  ## ", " # # ", "#  # ", "#####", "   # ", "   # "],
  "5": ["#####", "#    ", "#### ", "    #", "    #", "#   #", " ### "],
  "6": ["  ## ", " #   ", "#    ", "#### ", "#   #", "#   #", " ### "],
  "7": ["#####", "    #", "   # ", "  #  ", " #   ", " #   ", " #   "],
  "8": [" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "],
  "9": [" ### ", "#   #", "#   #", " ####", "    #", "   # ", " ##  "],
  $: ["  #  ", " ####", "# #  ", " ### ", "  # #", "#### ", "  #  "],
  ".": ["     ", "     ", "     ", "     ", "     ", " ##  ", " ##  "],
  " ": ["     ", "     ", "     ", "     ", "     ", "     ", "     "],
};

export function receiptPng(lines: string[], scale = 6): Buffer {
  const cols = Math.max(...lines.map((l) => l.length));
  const width = (cols * 6 + 4) * scale;
  const height = (lines.length * 10 + 4) * scale;
  const pixels = Buffer.alloc(width * height, 255);
  lines.forEach((line, row) => {
    [...line.toUpperCase()].forEach((ch, col) => {
      const glyph = FONT[ch];
      if (!glyph) throw new Error(`no glyph for ${ch}`);
      glyph.forEach((bits, gy) =>
        [...bits].forEach((bit, gx) => {
          if (bit !== "#") return;
          for (let dy = 0; dy < scale; dy++)
            for (let dx = 0; dx < scale; dx++) {
              const x = (2 + col * 6 + gx) * scale + dx;
              const y = (2 + row * 10 + gy) * scale + dy;
              pixels[y * width + x] = 0;
            }
        }),
      );
    });
  });
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
