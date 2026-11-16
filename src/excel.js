// Lector y Escritor nativo de CSV / TSV / XLSX (Google Forms & Microsoft Excel)
// Usa únicamente módulos nativos de Node.js (node:zlib).

const zlib = require('node:zlib');

// ==========================================
// 1. PARSER DE CSV / TSV / TEXTO DE FORMS
// ==========================================

function detectDelimiter(sampleLine) {
  const counts = {
    '\t': (sampleLine.match(/\t/g) || []).length,
    ';': (sampleLine.match(/;/g) || []).length,
    ',': (sampleLine.match(/,/g) || []).length,
  };
  if (counts['\t'] > 0 && counts['\t'] >= counts[';'] && counts['\t'] >= counts[',']) return '\t';
  if (counts[';'] > counts[',']) return ';';
  return ',';
}

function parseCSVRows(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const firstNonEmpty = clean.split('\n').find((l) => l.trim().length > 0) || '';
  const delimiter = detectDelimiter(firstNonEmpty);

  const rows = [];
  let row = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        row.push(current.trim());
        current = '';
      } else if (ch === '\n') {
        row.push(current.trim());
        if (row.some((cell) => cell !== '')) rows.push(row);
        row = [];
        current = '';
      } else {
        current += ch;
      }
    }
  }
  row.push(current.trim());
  if (row.some((cell) => cell !== '')) rows.push(row);
  return rows;
}

// ==========================================
// 2. LECTOR NATIVO DE ARCHIVOS .XLSX (ZIP+XML)
// ==========================================

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function extractZipFiles(buffer) {
  const files = {};
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const flags = buffer.readUInt16LE(offset + 6);
    const compression = buffer.readUInt16LE(offset + 8);
    let compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const fileName = buffer.slice(offset + 30, offset + 30 + fileNameLen).toString('utf8');
    const dataStart = offset + 30 + fileNameLen + extraLen;

    if ((flags & 0x08) && compressedSize === 0) {
      break;
    }

    const rawData = buffer.slice(dataStart, dataStart + compressedSize);
    try {
      if (compression === 0) {
        files[fileName] = rawData;
      } else if (compression === 8) {
        files[fileName] = zlib.inflateRawSync(rawData);
      }
    } catch (_) {}
    offset = dataStart + compressedSize;
  }

  if (Object.keys(files).length === 0 || !files['xl/worksheets/sheet1.xml']) {
    let eocd = buffer.length - 22;
    while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    if (eocd >= 0) {
      const cdEntries = buffer.readUInt16LE(eocd + 10);
      let cdOffset = buffer.readUInt32LE(eocd + 16);
      for (let i = 0; i < cdEntries && cdOffset < buffer.length; i++) {
        if (buffer.readUInt32LE(cdOffset) !== 0x02014b50) break;
        const compression = buffer.readUInt16LE(cdOffset + 10);
        const compressedSize = buffer.readUInt32LE(cdOffset + 20);
        const fileNameLen = buffer.readUInt16LE(cdOffset + 28);
        const extraLen = buffer.readUInt16LE(cdOffset + 30);
        const commentLen = buffer.readUInt16LE(cdOffset + 32);
        const localHeaderOffset = buffer.readUInt32LE(cdOffset + 42);
        const fileName = buffer.slice(cdOffset + 46, cdOffset + 46 + fileNameLen).toString('utf8');

        const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
        const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
        const rawData = buffer.slice(dataStart, dataStart + compressedSize);
        try {
          if (compression === 0) files[fileName] = rawData;
          else if (compression === 8) files[fileName] = zlib.inflateRawSync(rawData);
        } catch (_) {}

        cdOffset += 46 + fileNameLen + extraLen + commentLen;
      }
    }
  }
  return files;
}

function colLettersToIndex(letters) {
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return col - 1;
}

function parseXLSXBuffer(buffer) {
  const files = extractZipFiles(buffer);
  const sharedStrings = [];
  if (files['xl/sharedStrings.xml']) {
    const sstXml = files['xl/sharedStrings.xml'].toString('utf8');
    const siMatches = sstXml.match(/<si[\s>][\s\S]*?<\/si>/g) || [];
    for (const si of siMatches) {
      const tMatches = si.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) || [];
      const text = tMatches
        .map((t) => decodeXmlEntities(t.replace(/<[^>]+>/g, '')))
        .join('');
      sharedStrings.push(text.trim());
    }
  }

  const sheetKey = Object.keys(files).find((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k));
  if (!sheetKey) {
    throw new Error('No se encontró una hoja de cálculo válida dentro del archivo .xlsx');
  }

  const sheetXml = files[sheetKey].toString('utf8');
  const rowMatches = sheetXml.match(/<row[\s>][\s\S]*?<\/row>/g) || [];
  const rows = [];

  for (const rowXml of rowMatches) {
    const row = [];
    const cellRegex = /<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let match;
    while ((match = cellRegex.exec(rowXml)) !== null) {
      const attrs = match[1] || '';
      const inner = match[2] || '';
      const refMatch = attrs.match(/\br="([A-Z]+)\d+"/);
      const typeMatch = attrs.match(/\bt="([^"]+)"/);
      const colIdx = refMatch ? colLettersToIndex(refMatch[1]) : row.length;
      const cellType = typeMatch ? typeMatch[1] : '';

      let value = '';
      if (cellType === 'inlineStr') {
        const tMatch = inner.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/);
        value = tMatch ? decodeXmlEntities(tMatch[1]) : '';
      } else {
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        const rawVal = vMatch ? vMatch[1].trim() : '';
        if (cellType === 's') {
          const idx = parseInt(rawVal, 10);
          value = sharedStrings[idx] !== undefined ? sharedStrings[idx] : rawVal;
        } else {
          value = decodeXmlEntities(rawVal);
        }
      }
      while (row.length < colIdx) row.push('');
      row[colIdx] = String(value).trim();
    }
    if (row.some((c) => c !== '')) rows.push(row);
  }
  return rows;
}

// ==========================================
// 3. EXTRACTOR DINÁMICO DE VARIABLES DE GOOGLE FORMS
// ==========================================

function normalizeHeader(h) {
  return String(h || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function cleanDNI(raw) {
  let str = String(raw || '').trim();
  str = str.replace(/\.0+$/, '');
  const digitsOnly = str.replace(/[^0-9A-Za-z]/g, '');
  if (/^\d{7}$/.test(digitsOnly)) {
    return '0' + digitsOnly;
  }
  return digitsOnly;
}

function looksLikeDNI(val) {
  const cleaned = cleanDNI(val);
  return /^\d{7,12}$/.test(cleaned);
}

function looksLikeTimestamp(val) {
  const s = String(val || '').trim();
  return /^\d{1,4}[\/\-]\d{1,2}[\/\-]\d{1,4}/.test(s) || /\d{1,2}:\d{2}/.test(s);
}

function extractParticipantsFromRows(rows) {
  if (!rows || rows.length === 0) return [];

  let dniCol = -1;
  let nameCol = -1;
  let apellidoCol = -1;
  let timestampCol = -1;
  let startRow = 0;

  const rawHeaders = rows[0].map((c) => String(c || '').trim());
  const firstRow = rawHeaders.map(normalizeHeader);
  const hasHeader = firstRow.some(
    (h) =>
      h.includes('dni') ||
      h.includes('documento') ||
      h.includes('cedula') ||
      h.includes('nombre') ||
      h.includes('apellido') ||
      h.includes('participante') ||
      h.includes('marca temporal') ||
      h.includes('timestamp') ||
      h.includes('correo') ||
      h.includes('email')
  );

  if (hasHeader) {
    startRow = 1;
    firstRow.forEach((h, idx) => {
      if (timestampCol === -1 && (h.includes('marca temporal') || h.includes('timestamp'))) {
        timestampCol = idx;
      } else if (
        dniCol === -1 &&
        (h.includes('dni') ||
          h.includes('documento') ||
          h.includes('cedula') ||
          h.includes('codigo') ||
          h.includes('identidad'))
      ) {
        dniCol = idx;
      } else if (
        nameCol === -1 &&
        (h.includes('nombre') || h.includes('participante') || h.includes('asistente'))
      ) {
        nameCol = idx;
      } else if (apellidoCol === -1 && h.includes('apellido') && !h.includes('nombre')) {
        apellidoCol = idx;
      }
    });
  }

  if (dniCol === -1 || nameCol === -1) {
    const sampleRow = rows[startRow] || rows[0];
    if (sampleRow) {
      sampleRow.forEach((cell, idx) => {
        if (idx !== timestampCol && dniCol === -1 && looksLikeDNI(cell)) {
          dniCol = idx;
        }
      });
      sampleRow.forEach((cell, idx) => {
        if (
          idx !== dniCol &&
          idx !== timestampCol &&
          nameCol === -1 &&
          !looksLikeTimestamp(cell) &&
          /[a-zA-ZáéíóúÁÉÍÓÚñÑ]{1,}/.test(cell)
        ) {
          nameCol = idx;
        }
      });
    }
  }

  if (dniCol === -1) dniCol = 0;
  if (nameCol === -1) nameCol = dniCol === 0 ? 1 : 0;

  // Identificar todas las demás columnas/variables que vinieron del Google Forms
  const extraCols = [];
  if (hasHeader) {
    rawHeaders.forEach((colName, idx) => {
      if (
        idx !== dniCol &&
        idx !== nameCol &&
        idx !== apellidoCol &&
        idx !== timestampCol &&
        colName
      ) {
        extraCols.push({ idx, name: colName });
      }
    });
  }

  const participants = [];
  for (let i = startRow; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;

    let rawDni = r[dniCol] || '';
    let rawName = r[nameCol] || '';
    if (apellidoCol !== -1 && r[apellidoCol]) {
      rawName = `${rawName} ${r[apellidoCol]}`.trim();
    }

    if (!looksLikeDNI(rawDni) && looksLikeDNI(rawName)) {
      const tmp = rawDni;
      rawDni = rawName;
      rawName = tmp;
    }

    const dni = cleanDNI(rawDni);
    const nombres = String(rawName || '').replace(/\s+/g, ' ').trim();

    if (dni && (hasHeader ? dni.length >= 1 : dni.length >= 4) && nombres) {
      const datos_extra = {};
      for (const ec of extraCols) {
        if (r[ec.idx] !== undefined && String(r[ec.idx]).trim() !== '') {
          datos_extra[ec.name] = String(r[ec.idx]).trim();
        }
      }
      participants.push({
        dni,
        nombres,
        datos_extra,
      });
    }
  }

  return participants;
}

// ==========================================
// 4. GENERADOR NATIVO DE ARCHIVOS .XLSX (ZIP+XML)
// ==========================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const uncompressed = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(String(entry.data), 'utf8');
    const compressed = zlib.deflateRawSync(uncompressed);
    const crc = crc32(uncompressed);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += 30 + nameBuf.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colIndexToLetter(index) {
  let n = index + 1;
  let str = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    str = String.fromCharCode(65 + rem) + str;
    n = Math.floor((n - 1) / 26);
  }
  return str;
}

function buildWorksheetXml(rows) {
  let sheetData = '';
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    let cells = '';
    const isHeader = r === 0;
    for (let c = 0; c < row.length; c++) {
      const ref = `${colIndexToLetter(c)}${r + 1}`;
      const val = row[c];
      const styleAttr = isHeader ? ' s="1"' : '';
      if (typeof val === 'number' && Number.isFinite(val)) {
        cells += `<c r="${ref}"${styleAttr}><v>${val}</v></c>`;
      } else {
        cells += `<c r="${ref}" t="inlineStr"${styleAttr}><is><t>${escapeXml(val)}</t></is></c>`;
      }
    }
    sheetData += `<row r="${r + 1}">${cells}</row>`;
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheetData}</sheetData>
</worksheet>`;
}

function buildXLSXBuffer(sheets) {
  const entries = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join('\n  ')}
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${sheets
      .map(
        (s, i) =>
          `<sheet name="${escapeXml(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
      )
      .join('\n    ')}
  </sheets>
</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    )
    .join('\n  ')}
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1E293B"/></patternFill></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  </cellXfs>
</styleSheet>`,
    },
  ];

  sheets.forEach((s, i) => {
    entries.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: buildWorksheetXml(s.rows),
    });
  });

  return createZipBuffer(entries);
}

function buildCSVString(rows, delimiter = ';') {
  const lines = rows.map((row) =>
    row
      .map((cell) => {
        const s = String(cell ?? '');
        if (s.includes(delimiter) || s.includes('"') || s.includes('\n')) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      })
      .join(delimiter)
  );
  return '\uFEFF' + lines.join('\r\n');
}

module.exports = {
  parseCSVRows,
  parseXLSXBuffer,
  extractParticipantsFromRows,
  buildXLSXBuffer,
  buildCSVString,
  cleanDNI,
};
