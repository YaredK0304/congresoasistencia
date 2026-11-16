// Generador nativo de Código QR en formato SVG (ISO/IEC 18004, Modo Byte, Nivel L/M)
// Cero dependencias externas, funciona 100% offline.

const GF256_EXP = new Uint8Array(512);
const GF256_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF256_EXP[i] = x;
    GF256_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF256_EXP[i] = GF256_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF256_EXP[GF256_LOG[a] + GF256_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF256_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const msg = new Uint8Array(data.length + ecLen);
  msg.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return msg.slice(data.length);
}

// Parámetros para Nivel de Corrección L (Versiones 1 a 10)
// [totalCodewords, ecCodewordsPerBlock, numBlocksGroup1, dataCodewordsGroup1, numBlocksGroup2, dataCodewordsGroup2, alignmentPositions]
const VERSION_TABLE_L = [
  null,
  [26, 7, 1, 19, 0, 0, []],
  [44, 10, 1, 34, 0, 0, [6, 18]],
  [70, 15, 1, 55, 0, 0, [6, 22]],
  [100, 20, 1, 80, 0, 0, [6, 26]],
  [134, 26, 1, 108, 0, 0, [6, 30]],
  [172, 18, 2, 68, 0, 0, [6, 34]],
  [196, 20, 2, 78, 0, 0, [6, 22, 38]],
  [242, 24, 2, 97, 0, 0, [6, 24, 42]],
  [292, 30, 2, 116, 0, 0, [6, 26, 46]],
  [346, 18, 2, 68, 2, 69, [6, 28, 50]],
];

function chooseVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const info = VERSION_TABLE_L[v];
    const totalDataBytes = info[2] * info[3] + info[4] * info[5];
    const headerBits = 4 + (v <= 9 ? 8 : 16);
    const maxPayload = Math.floor((totalDataBytes * 8 - headerBits) / 8);
    if (byteLen <= maxPayload) return v;
  }
  throw new Error('Texto demasiado largo para el generador QR (máx ~270 bytes)');
}

function encodeDataBits(bytes, version) {
  const info = VERSION_TABLE_L[version];
  const totalDataCodewords = info[2] * info[3] + info[4] * info[5];
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  // Modo Byte (0100)
  pushBits(0b0100, 4);
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);

  // Terminador (hasta 4 ceros)
  const maxBits = totalDataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = new Uint8Array(totalDataCodewords);
  for (let i = 0; i < bits.length / 8; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
    codewords[i] = b;
  }
  const padBytes = [0xec, 0x11];
  for (let i = bits.length / 8, p = 0; i < totalDataCodewords; i++, p ^= 1) {
    codewords[i] = padBytes[p];
  }

  // Dividir en bloques y calcular Reed-Solomon
  const ecLen = info[1];
  const blocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let b = 0; b < info[2]; b++) {
    const slice = codewords.slice(offset, offset + info[3]);
    offset += info[3];
    blocks.push(slice);
    ecBlocks.push(rsEncode(slice, ecLen));
  }
  for (let b = 0; b < info[4]; b++) {
    const slice = codewords.slice(offset, offset + info[5]);
    offset += info[5];
    blocks.push(slice);
    ecBlocks.push(rsEncode(slice, ecLen));
  }

  // Intercalar bloques
  const finalBytes = [];
  const maxBlockLen = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxBlockLen; i++) {
    for (const blk of blocks) {
      if (i < blk.length) finalBytes.push(blk[i]);
    }
  }
  for (let i = 0; i < ecLen; i++) {
    for (const ecBlk of ecBlocks) {
      finalBytes.push(ecBlk[i]);
    }
  }
  return finalBytes;
}

function createMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFunctionModule = (r, c, dark) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r][c] = dark;
    isFunction[r][c] = true;
  };

  // Patrones de búsqueda (Finder patterns) + separadores
  const drawFinder = (row, col) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = row + dr;
        const c = col + dc;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunctionModule(r, c, inOuter && (onBorder || inInner));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Patrones de sincronización (Timing patterns)
  for (let i = 8; i < size - 8; i++) {
    setFunctionModule(6, i, i % 2 === 0);
    setFunctionModule(i, 6, i % 2 === 0);
  }

  // Patrones de alineación
  const alignPos = VERSION_TABLE_L[version][6];
  for (const r of alignPos) {
    for (const c of alignPos) {
      if (
        (r === 6 && c === 6) ||
        (r === 6 && c === size - 7) ||
        (r === size - 7 && c === 6)
      ) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFunctionModule(r + dr, c + dc, dark);
        }
      }
    }
  }

  // Módulo oscuro fijo y reserva de formato
  setFunctionModule(size - 8, 8, true);
  for (let i = 0; i <= 8; i++) {
    if (!isFunction[8][i]) setFunctionModule(8, i, false);
    if (!isFunction[i][8]) setFunctionModule(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    setFunctionModule(8, size - 1 - i, false);
    setFunctionModule(size - 1 - i, 8, false);
  }

  // Reserva de versión para v >= 7
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
    }
    const verBits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((verBits >> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunctionModule(a, b, bit);
      setFunctionModule(b, a, bit);
    }
  }

  return { size, modules, isFunction };
}

function drawFormatBits(modules, size, mask) {
  // Nivel L = 01
  const data = (0b01 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  }
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => ((bits >> i) & 1) !== 0;

  for (let i = 0; i <= 5; i++) modules[8][i] = bit(i);
  modules[8][7] = bit(6);
  modules[8][8] = bit(7);
  modules[7][8] = bit(8);
  for (let i = 9; i < 15; i++) modules[14 - i][8] = bit(i);

  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = bit(i);
  modules[size - 8][8] = true;
}

function generateQRMatrix(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  const version = chooseVersion(bytes.length);
  const codewords = encodeDataBits(bytes, version);
  const { size, modules, isFunction } = createMatrix(version);

  // Colocar bits en zigzag de derecha a izquierda
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (!isFunction[r][c] && bitIdx < totalBits) {
          const dark = ((codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1) !== 0;
          modules[r][c] = dark;
          bitIdx++;
        }
      }
    }
  }

  // Aplicar máscara 0 ((r + c) % 2 === 0)
  const mask = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!isFunction[r][c] && (r + c) % 2 === 0) {
        modules[r][c] = !modules[r][c];
      }
    }
  }
  drawFormatBits(modules, size, mask);
  return modules;
}

function generateQRSVG(text, margin = 3) {
  const matrix = generateQRMatrix(text);
  const size = matrix.length;
  const total = size + margin * 2;
  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) {
        path += `M${c + margin},${r + margin}h1v1h-1z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" width="100%" height="100%">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <path d="${path}" fill="#0f172a"/>
</svg>`;
}

module.exports = { generateQRSVG };
