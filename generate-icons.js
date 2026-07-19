/**
 * generate-icons.js — Icon Generator
 * 
 * Run with Node.js to generate extension icons as PNG files.
 * Creates simple bell/alert icons at 16, 32, 48, and 128px.
 * 
 * Usage: node generate-icons.js
 * 
 * Since we can't use canvas in Node.js without dependencies,
 * this script generates icons as raw PNG using a minimal PNG encoder.
 */

const fs = require('fs');
const path = require('path');

// Minimal PNG encoder for simple icons
function createPNG(width, height, pixels) {
  // pixels is Uint8Array of RGBA values (width * height * 4)
  
  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c;
    }
    for (let i = 0; i < buf.length; i++) {
      crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function adler32(data) {
    let a = 1, b = 0;
    for (let i = 0; i < data.length; i++) {
      a = (a + data[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  function makeChunk(type, data) {
    const len = data.length;
    const buf = Buffer.alloc(len + 12);
    buf.writeUInt32BE(len, 0);
    buf.write(type, 4, 4, 'ascii');
    data.copy(buf, 8);
    const crcData = Buffer.alloc(4 + len);
    crcData.write(type, 0, 4, 'ascii');
    data.copy(crcData, 4);
    buf.writeUInt32BE(crc32(crcData), 8 + len);
    return buf;
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type (RGBA)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw image data with filter bytes
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // No filter
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = y * (1 + width * 4) + 1 + x * 4;
      rawData[dstIdx] = pixels[srcIdx];     // R
      rawData[dstIdx + 1] = pixels[srcIdx + 1]; // G
      rawData[dstIdx + 2] = pixels[srcIdx + 2]; // B
      rawData[dstIdx + 3] = pixels[srcIdx + 3]; // A
    }
  }

  // Compress with deflate (use zlib)
  const zlib = require('zlib');
  const compressed = zlib.deflateSync(rawData);
  const idatData = Buffer.from(compressed);

  // IEND
  const iend = Buffer.alloc(0);

  // Assemble PNG
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = makeChunk('IHDR', ihdr);
  const idatChunk = makeChunk('IDAT', idatData);
  const iendChunk = makeChunk('IEND', iend);

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

/**
 * Draw a bell icon on a pixel buffer.
 */
function drawBellIcon(size) {
  const pixels = new Uint8Array(size * size * 4);

  // Colors
  const bgColor = [88, 166, 255]; // Blue accent
  const bellColor = [255, 255, 255]; // White
  const ringColor = [163, 113, 247]; // Purple

  // Helper: set pixel
  function setPixel(x, y, r, g, b, a = 255) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const idx = (y * size + x) * 4;
    // Alpha blend
    const srcA = a / 255;
    const dstA = pixels[idx + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA > 0) {
      pixels[idx] = Math.round((r * srcA + pixels[idx] * dstA * (1 - srcA)) / outA);
      pixels[idx + 1] = Math.round((g * srcA + pixels[idx + 1] * dstA * (1 - srcA)) / outA);
      pixels[idx + 2] = Math.round((b * srcA + pixels[idx + 2] * dstA * (1 - srcA)) / outA);
      pixels[idx + 3] = Math.round(outA * 255);
    }
  }

  // Draw filled circle
  function fillCircle(cx, cy, r, color, alpha = 255) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= r) {
          const edgeAlpha = Math.min(1, r - dist + 0.5) * (alpha / 255);
          setPixel(x, y, color[0], color[1], color[2], Math.round(edgeAlpha * 255));
        }
      }
    }
  }

  // Draw filled rounded rectangle
  function fillRoundRect(x1, y1, x2, y2, radius, color, alpha = 255) {
    for (let y = Math.floor(y1); y <= Math.ceil(y2); y++) {
      for (let x = Math.floor(x1); x <= Math.ceil(x2); x++) {
        let inside = false;
        // Check if inside the rounded rectangle
        if (x >= x1 + radius && x <= x2 - radius) inside = true;
        else if (y >= y1 + radius && y <= y2 - radius) inside = true;
        else {
          // Check corner circles
          const corners = [
            [x1 + radius, y1 + radius],
            [x2 - radius, y1 + radius],
            [x1 + radius, y2 - radius],
            [x2 - radius, y2 - radius]
          ];
          for (const [cx, cy] of corners) {
            const dx = x - cx;
            const dy = y - cy;
            if (Math.sqrt(dx * dx + dy * dy) <= radius + 0.5) {
              inside = true;
              break;
            }
          }
        }
        if (inside && x >= x1 && x <= x2 && y >= y1 && y <= y2) {
          setPixel(x, y, color[0], color[1], color[2], alpha);
        }
      }
    }
  }

  const s = size;
  const cx = s / 2;
  const margin = s * 0.08;

  // Background: rounded rectangle with gradient feel
  const bgRadius = s * 0.2;
  fillRoundRect(margin, margin, s - margin, s - margin, bgRadius, bgColor);
  
  // Add a subtle gradient overlay (darker at bottom)
  for (let y = Math.floor(s * 0.5); y < s - margin; y++) {
    const progress = (y - s * 0.5) / (s * 0.5);
    const darken = Math.round(progress * 40);
    for (let x = Math.floor(margin); x < s - margin; x++) {
      const idx = (y * size + x) * 4;
      if (pixels[idx + 3] > 0) {
        pixels[idx] = Math.max(0, pixels[idx] - darken);
        pixels[idx + 1] = Math.max(0, pixels[idx + 1] - darken);
        pixels[idx + 2] = Math.max(0, pixels[idx + 2] - darken);
      }
    }
  }

  // Bell body (trapezoid approximated as an ellipse + rectangle)
  const bellCx = cx;
  const bellTop = s * 0.22;
  const bellBottom = s * 0.68;
  const bellWidth = s * 0.2;

  // Bell dome (top arc)
  for (let y = Math.floor(bellTop); y <= Math.ceil(bellBottom); y++) {
    const progress = (y - bellTop) / (bellBottom - bellTop);
    const halfWidth = bellWidth * (0.4 + progress * 0.6); // Widens toward bottom
    for (let x = Math.floor(bellCx - halfWidth); x <= Math.ceil(bellCx + halfWidth); x++) {
      const dx = Math.abs(x - bellCx);
      if (dx <= halfWidth + 0.5) {
        const edgeAlpha = Math.min(1, halfWidth - dx + 0.5);
        setPixel(x, y, bellColor[0], bellColor[1], bellColor[2], Math.round(edgeAlpha * 255));
      }
    }
  }

  // Bell brim (wide horizontal bar at bottom)
  const brimY = s * 0.68;
  const brimH = s * 0.06;
  const brimW = s * 0.3;
  fillRoundRect(bellCx - brimW, brimY, bellCx + brimW, brimY + brimH, brimH / 2, bellColor);

  // Bell clapper (small circle at bottom center)
  fillCircle(bellCx, s * 0.78, s * 0.05, bellColor);

  // Bell knob (small circle at top)
  fillCircle(bellCx, bellTop - s * 0.01, s * 0.035, bellColor);

  // Sound waves (right side)
  const waveX = bellCx + bellWidth + s * 0.08;
  const waveY = (bellTop + bellBottom) / 2;
  for (let i = 0; i < 3; i++) {
    const r = s * 0.04 + i * s * 0.05;
    // Draw arc (quarter circle)
    for (let angle = -0.6; angle < 0.6; angle += 0.02) {
      const px = waveX + Math.cos(angle) * r;
      const py = waveY + Math.sin(angle) * r;
      setPixel(px, py, ringColor[0], ringColor[1], ringColor[2], 200);
      // Make lines thicker
      setPixel(px + 1, py, ringColor[0], ringColor[1], ringColor[2], 150);
    }
  }

  return pixels;
}

// Generate icons
const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

const sizes = [16, 32, 48, 128];

for (const size of sizes) {
  const pixels = drawBellIcon(size);
  const png = createPNG(size, size, pixels);
  const filePath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Generated: ${filePath} (${png.length} bytes)`);
}

console.log('All icons generated successfully!');
