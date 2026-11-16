const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const db = require('./src/database');
const excel = require('./src/excel');
const { generateQRSVG } = require('./src/qr');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update(__dirname + '_congreso_secret_key').digest('hex');

// ==========================================
// CACHÉ EN RAM DE ARCHIVOS ESTÁTICOS (0 LECTURAS DE DISCO EN HORA PUNTA)
// ==========================================

const staticCache = new Map();
function getStaticFile(fullPath) {
  const cached = staticCache.get(fullPath);
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) return null;
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.buffer;
    }
    const buffer = fs.readFileSync(fullPath);
    staticCache.set(fullPath, { mtimeMs: stat.mtimeMs, buffer });
    return buffer;
  } catch (_) {
    return null;
  }
}

// Caché de QR SVG en RAM
const qrCache = new Map();
function getCachedQR(url) {
  if (qrCache.has(url)) return qrCache.get(url);
  const svg = generateQRSVG(url);
  if (qrCache.size > 50) qrCache.clear();
  qrCache.set(url, svg);
  return svg;
}

// ==========================================
// AUTENTICACIÓN Y SEGURIDAD (/login & /admin)
// ==========================================

function createSessionToken(usuario) {
  const exp = Date.now() + 12 * 60 * 60 * 1000; // 12 horas
  const payload = `${usuario}|${exp}`;
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('hex');
  return Buffer.from(`${payload}|${sig}`, 'utf8').toString('base64url');
}

function verifySessionToken(token) {
  if (!token) return null;
  try {
    const decoded = Buffer.from(String(token), 'base64url').toString('utf8');
    const parts = decoded.split('|');
    if (parts.length !== 3) return null;
    const [usuario, expStr, sig] = parts;
    const exp = Number(expStr);
    if (!exp || Date.now() > exp) return null;

    const expectedSig = crypto
      .createHmac('sha256', SESSION_SECRET)
      .update(`${usuario}|${expStr}`)
      .digest('hex');

    if (
      sig.length === expectedSig.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))
    ) {
      return { usuario };
    }
  } catch (_) {}
  return null;
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const pair of raw.split(';')) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      out[k] = decodeURIComponent(v);
    }
  }
  return out;
}

function isAdminAuthenticated(req) {
  const cookies = parseCookies(req);
  return Boolean(verifySessionToken(cookies.congreso_admin_session));
}

// Protección contra fuerza bruta en /api/login
const loginAttempts = new Map();
function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + 5 * 60 * 1000 };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + 5 * 60 * 1000;
  }
  if (entry.count >= 8) {
    return false;
  }
  return true;
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + 5 * 60 * 1000 };
  entry.count += 1;
  loginAttempts.set(ip, entry);
}

// ==========================================
// RED Y UTILIDADES HTTP
// ==========================================

function getLocalIPv4() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        candidates.push(net.address);
      }
    }
  }
  return (
    candidates.find((ip) => ip.startsWith('192.168.')) ||
    candidates.find((ip) => ip.startsWith('10.')) ||
    candidates[0] ||
    'localhost'
  );
}

function readJsonBody(req, maxBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('La petición supera el tamaño máximo permitido'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('Formato JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

function fetchUrlText(targetUrl, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) return reject(new Error('Demasiadas redirecciones'));
    const client = targetUrl.startsWith('https') ? https : http;
    const req = client.get(targetUrl, { timeout: 8000 }, (resp) => {
      if (
        resp.statusCode >= 300 &&
        resp.statusCode < 400 &&
        resp.headers.location
      ) {
        const nextUrl = new URL(resp.headers.location, targetUrl).toString();
        resp.resume();
        return resolve(fetchUrlText(nextUrl, redirectsLeft - 1));
      }
      if (resp.statusCode !== 200) {
        resp.resume();
        return reject(
          new Error(
            `No se pudo descargar la hoja (HTTP ${resp.statusCode}). Verifica que el Google Sheet tenga acceso "Cualquier persona con el enlace puede ver".`
          )
        );
      }
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Tiempo de espera agotado al conectar con Google Sheets'));
    });
    req.on('error', reject);
  });
}

function buildGoogleSheetsCsvUrl(rawUrl) {
  const urlStr = String(rawUrl || '').trim();

  if (urlStr.includes('docs.google.com/forms') || urlStr.includes('forms.gle')) {
    throw new Error(
      'Pegaste el enlace para rellenar el formulario (Google Forms). Abre tu formulario → pestaña "Respuestas" → botón verde "Ver en Hojas de cálculo" (Google Sheets), ponlo como "Cualquier persona con el enlace puede ver" y pega ese enlace aquí.'
    );
  }

  if (urlStr.includes('/spreadsheets/d/e/')) {
    if (urlStr.includes('output=csv')) return urlStr;
    return urlStr
      .replace(/\/pubhtml.*$/, '/pub?output=csv')
      .replace(/\/pub(\?.*)?$/, '/pub?output=csv');
  }

  const matchId = urlStr.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{10,})/);
  if (!matchId) {
    return urlStr;
  }
  const sheetId = matchId[1];
  const gidMatch = urlStr.match(/[#&?]gid=(\d+)/);
  const gidParam = gidMatch ? `&gid=${gidMatch[1]}` : '';
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv${gidParam}`;
}

let isSyncingSheets = false;
let lastSyncMs = 0;

async function sincronizarDesdeSheetsUrl(rawUrl) {
  const url = String(rawUrl || db.getConfig().sheets_url || '').trim();
  if (!url) return null;
  if (isSyncingSheets) return null;

  isSyncingSheets = true;
  try {
    const csvUrl = buildGoogleSheetsCsvUrl(url);
    const csvText = await fetchUrlText(csvUrl);
    const rows = excel.parseCSVRows(csvText);
    const extraidos = excel.extractParticipantsFromRows(rows);
    if (extraidos.length === 0) {
      throw new Error(
        'Se conectó a la hoja de Google Sheets, pero aún no tiene filas con DNI y Nombres.'
      );
    }
    const resultado = db.importarParticipantes(extraidos, 'FORMS');
    const ahoraStr = new Date().toLocaleString('es-PE');
    db.updateConfig({
      sheets_url: url,
      ultima_sincronizacion: ahoraStr,
    });
    lastSyncMs = Date.now();
    return {
      extraidos: extraidos.length,
      ...resultado,
      ultima_sincronizacion: ahoraStr,
    };
  } finally {
    isSyncingSheets = false;
  }
}

// Disparo en segundo plano NO bloqueante (nunca retrasa la respuesta al asistente)
function triggerBackgroundSyncIfNeeded() {
  const url = db.getConfig().sheets_url;
  if (!url || isSyncingSheets || Date.now() - lastSyncMs < 20000) return;
  sincronizarDesdeSheetsUrl(url).catch(() => {});
}

function buildReportRows(resumen) {
  const fechas = resumen.fechas || [];
  const colsForms = resumen.columnas_forms || [];

  const headerResumen = [
    'DNI',
    'Nombres y Apellidos',
    ...colsForms,
    'Origen',
    'Estado Actual',
    ...fechas.map((f) => `Horas ${f}`),
    ...fechas.map((f) => `Bloques ${f}`),
    'Total Minutos',
    'Total Horas (Xh Ym)',
    'Total Horas (Decimal)',
    'Cumple Meta',
  ];

  const rowsResumen = [headerResumen];
  for (const p of resumen.participantes) {
    rowsResumen.push([
      p.dni,
      p.nombres,
      ...colsForms.map((col) => p.datos_extra?.[col] || ''),
      p.origen,
      p.dentro ? `EN AUDITORIO (desde ${p.sesion_abierta?.hora_entrada})` : 'FUERA',
      ...fechas.map((f) => p.por_fecha[f]?.horas_texto || '0h 00m'),
      ...fechas.map((f) => p.por_fecha[f]?.resumen_bloques || '-'),
      p.minutos_total,
      p.horas_total_texto,
      p.horas_total_decimal,
      p.cumple_meta ? 'SÍ' : 'NO',
    ]);
  }

  const headerDetalle = [
    'ID Bloque',
    'Fecha',
    'DNI',
    'Nombres y Apellidos',
    ...colsForms,
    'Hora Entrada',
    'Hora Salida',
    'Minutos Acumulados',
    'Duración (Xh Ym)',
    'Estado Bloque',
    'Observación / Nota',
  ];
  const rowsDetalle = [headerDetalle];
  for (const p of resumen.participantes) {
    for (const b of p.bloques) {
      rowsDetalle.push([
        b.id,
        b.fecha,
        p.dni,
        p.nombres,
        ...colsForms.map((col) => p.datos_extra?.[col] || ''),
        b.hora_entrada,
        b.hora_salida || 'EN CURSO',
        b.minutos,
        b.duracion_texto,
        b.en_curso ? 'DENTRO DEL AUDITORIO' : 'FINALIZADO',
        b.nota || '',
      ]);
    }
  }

  return { rowsResumen, rowsDetalle };
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const requestHandler = async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const clientIp =
      String(req.headers['x-forwarded-for'] || '')
        .split(',')[0]
        .trim() ||
      req.socket.remoteAddress ||
      'unknown';

    // ==========================================
    // ENDPOINTS DE LOGIN / LOGOUT
    // ==========================================

    if (pathname === '/api/login' && req.method === 'POST') {
      if (!checkLoginRateLimit(clientIp)) {
        return sendJson(res, 429, {
          ok: false,
          mensaje: 'Demasiados intentos fallidos. Espera 5 minutos.',
        });
      }
      const body = await readJsonBody(req, 16 * 1024);
      const valido = db.verificarCredencialesAdmin(body.usuario, body.password);
      if (!valido) {
        recordFailedLogin(clientIp);
        return sendJson(res, 401, {
          ok: false,
          mensaje: 'Usuario o contraseña incorrectos.',
        });
      }
      const token = createSessionToken(body.usuario || 'admin');
      return sendJson(
        res,
        200,
        { ok: true },
        {
          'Set-Cookie': `congreso_admin_session=${encodeURIComponent(
            token
          )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`,
        }
      );
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      return sendJson(
        res,
        200,
        { ok: true },
        {
          'Set-Cookie':
            'congreso_admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
        }
      );
    }

    // ==========================================
    // ENDPOINTS PÚBLICOS DE ASISTENCIA (ULTRA RÁPIDOS)
    // ==========================================

    if (pathname === '/api/info' && req.method === 'GET') {
      const ip = getLocalIPv4();
      const hostHeader = req.headers.host || `localhost:${PORT}`;
      const proto =
        String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
      const baseUrl =
        hostHeader.startsWith('localhost') || hostHeader.startsWith('127.0.0.1')
          ? `http://${ip}:${PORT}`
          : `${proto}://${hostHeader}`;
      const qrUrl = parsedUrl.searchParams.get('url') || baseUrl;
      const cfg = db.getConfig();

      return sendJson(res, 200, {
        ok: true,
        config: {
          nombre_evento: cfg.nombre_evento,
          subtitulo_evento: cfg.subtitulo_evento,
        },
        red: {
          ip,
          puerto: PORT,
          url_formulario_qr: baseUrl,
        },
        qr_svg: getCachedQR(qrUrl),
      });
    }

    if (pathname === '/api/qr.svg' && req.method === 'GET') {
      const ip = getLocalIPv4();
      const target = parsedUrl.searchParams.get('url') || `http://${ip}:${PORT}`;
      const svg = getCachedQR(target);
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
      });
      return res.end(svg);
    }

    if (pathname === '/api/buscar' && req.method === 'GET') {
      const q = parsedUrl.searchParams.get('q') || '';
      const fecha = parsedUrl.searchParams.get('fecha') || undefined;
      let resultados = db.buscarParticipantes(q, fecha);
      if (resultados.length === 0 && db.getConfig().sheets_url) {
        try {
          await sincronizarDesdeSheetsUrl();
          resultados = db.buscarParticipantes(q, fecha);
        } catch (_) {}
      }
      return sendJson(res, 200, { ok: true, resultados });
    }

    if (pathname === '/api/participante' && req.method === 'GET') {
      const dni = parsedUrl.searchParams.get('dni') || '';
      const fecha = parsedUrl.searchParams.get('fecha') || undefined;
      let estado = db.obtenerEstadoParticipante(dni, fecha);
      if (!estado && db.getConfig().sheets_url) {
        try {
          await sincronizarDesdeSheetsUrl();
          estado = db.obtenerEstadoParticipante(dni, fecha);
        } catch (_) {}
      }
      return sendJson(res, 200, { ok: true, encontrado: Boolean(estado), estado });
    }

    if (pathname === '/api/marcar' && req.method === 'POST') {
      const body = await readJsonBody(req, 32 * 1024);
      if (body.dni && !db.obtenerEstadoParticipante(body.dni) && db.getConfig().sheets_url) {
        try {
          await sincronizarDesdeSheetsUrl();
        } catch (_) {}
      }
      const resultado = db.registrarMarca({
        dni: body.dni,
        nombres: body.nombres,
        correo: body.correo,
        fechaCustom: body.fecha,
        horaCustom: body.hora,
        forzar: Boolean(body.forzar),
        nota: body.nota || '',
        sesion_previa: body.sesion_previa || null,
      });
      return sendJson(res, 200, resultado);
    }

    // ==========================================
    // PROTECCIÓN DE ENDPOINTS ADMINISTRATIVOS (/api/admin/*)
    // ==========================================

    if (pathname.startsWith('/api/admin/')) {
      if (!isAdminAuthenticated(req)) {
        return sendJson(res, 401, {
          ok: false,
          no_autenticado: true,
          mensaje: 'Sesión expirada o no iniciada. Ingresa en /login.',
        });
      }

      if (pathname === '/api/admin/resumen' && (req.method === 'GET' || req.method === 'POST')) {
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          const resumen = db.sincronizarEstadoCliente(body);
          return sendJson(res, 200, { ok: true, ...resumen });
        }
        const resumen = db.obtenerResumenGeneral();
        return sendJson(res, 200, { ok: true, ...resumen });
      }

      if (pathname === '/api/admin/config' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const cfg = db.updateConfig(body);
        return sendJson(res, 200, { ok: true, config: cfg });
      }

      if (pathname === '/api/admin/credenciales' && req.method === 'POST') {
        const body = await readJsonBody(req, 16 * 1024);
        db.cambiarPasswordAdmin(body.usuario, body.password);
        return sendJson(res, 200, {
          ok: true,
          mensaje: 'Credenciales de administrador actualizadas correctamente.',
        });
      }

      if (pathname === '/api/admin/importar' && req.method === 'POST') {
        const body = await readJsonBody(req);
        let rows = [];

        if (body.archivo_base64) {
          const buffer = Buffer.from(body.archivo_base64, 'base64');
          const nombre = String(body.nombre_archivo || '').toLowerCase();
          if (nombre.endsWith('.xlsx') || (buffer[0] === 0x50 && buffer[1] === 0x4b)) {
            rows = excel.parseXLSXBuffer(buffer);
          } else {
            rows = excel.parseCSVRows(buffer.toString('utf8'));
          }
        } else if (body.texto) {
          rows = excel.parseCSVRows(body.texto);
        }

        const extraidos = excel.extractParticipantsFromRows(rows);
        if (extraidos.length === 0) {
          return sendJson(res, 400, {
            ok: false,
            mensaje:
              'No se encontraron filas válidas con DNI y Nombres. Verifica que el archivo tenga columnas de DNI y Nombres.',
          });
        }

        const resultado = db.importarParticipantes(extraidos, 'FORMS');
        return sendJson(res, 200, {
          ok: true,
          mensaje: `Se procesaron ${extraidos.length} registros del Forms (${resultado.nuevos} nuevos, ${resultado.actualizados} actualizados). Variables extra detectadas: ${
            resultado.columnas_forms.length > 0 ? resultado.columnas_forms.join(', ') : 'Ninguna'
          }.`,
          ...resultado,
        });
      }

      if (pathname === '/api/admin/sincronizar-sheets' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const rawUrl = String(body.url || '').trim();
        if (!rawUrl) {
          return sendJson(res, 400, { ok: false, mensaje: 'Ingresa el enlace de Google Sheets' });
        }
        const resultado = await sincronizarDesdeSheetsUrl(rawUrl);
        return sendJson(res, 200, {
          ok: true,
          mensaje: `Sincronización exitosa: ${resultado.extraidos} inscritos leídos (${resultado.nuevos} nuevos, ${resultado.actualizados} actualizados).`,
          ...resultado,
        });
      }

      if (pathname === '/api/admin/bloque' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const estado = db.registrarBloqueManual(body);
        return sendJson(res, 200, { ok: true, estado });
      }

      if (pathname.startsWith('/api/admin/bloque/') && req.method === 'PUT') {
        const id = Number(pathname.split('/').pop());
        const body = await readJsonBody(req);
        db.actualizarBloque(id, body);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname.startsWith('/api/admin/bloque/') && req.method === 'DELETE') {
        const id = Number(pathname.split('/').pop());
        db.eliminarBloque(id);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/admin/cerrar-abiertas' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const resCierre = db.cerrarSesionesAbiertas({
          fecha: body.fecha,
          hora_cierre: body.hora_cierre,
        });
        return sendJson(res, 200, {
          ok: true,
          mensaje: `Se cerraron ${resCierre.cerradas} sesiones abiertas con hora de salida ${resCierre.hora_cierre}.`,
          ...resCierre,
        });
      }

      if (pathname === '/api/admin/demo' && req.method === 'POST') {
        const resumen = db.cargarDatosEjemplo();
        return sendJson(res, 200, {
          ok: true,
          mensaje:
            'Datos de demostración cargados (Ejemplo Lunes 8-11 / 15-17:30 y Martes 8-11 / 15-18).',
          ...resumen,
        });
      }

      if (pathname === '/api/admin/limpiar' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const resumen = db.limpiarTodo({
          incluirParticipantes: Boolean(body.incluirParticipantes),
        });
        return sendJson(res, 200, { ok: true, ...resumen });
      }

      if (pathname === '/api/admin/exportar.xlsx' && req.method === 'GET') {
        const resumen = db.obtenerResumenGeneral();
        const { rowsResumen, rowsDetalle } = buildReportRows(resumen);
        const xlsxBuf = excel.buildXLSXBuffer([
          { name: 'Resumen Horas Congreso', rows: rowsResumen },
          { name: 'Detalle Bloques Entrada-Salida', rows: rowsDetalle },
        ]);
        res.writeHead(200, {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="Reporte_Asistencia_Congreso_${resumen.hoy}.xlsx"`,
        });
        return res.end(xlsxBuf);
      }

      if (pathname === '/api/admin/exportar.csv' && req.method === 'GET') {
        const resumen = db.obtenerResumenGeneral();
        const { rowsResumen } = buildReportRows(resumen);
        const csvStr = excel.buildCSVString(rowsResumen, ';');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="Reporte_Asistencia_Congreso_${resumen.hoy}.csv"`,
        });
        return res.end(csvStr);
      }

      if (pathname === '/api/admin/plantilla.csv' && req.method === 'GET') {
        const plantilla = excel.buildCSVString(
          [
            ['Marca temporal', 'DNI', 'Nombres y Apellidos', 'Correo', 'Institución / Carrera'],
            ['16/11/2026 07:45:00', '72345678', 'Ana María Quispe Rojas', 'ana@ejemplo.pe', 'Ingeniería'],
            ['16/11/2026 07:48:10', '45891234', 'Carlos Eduardo Mendoza Vargas', 'carlos@ejemplo.pe', 'Medicina'],
          ],
          ';'
        );
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="Plantilla_Forms_Participantes.csv"',
        });
        return res.end(plantilla);
      }
    }

    // ==========================================
    // RUTAS DE PÁGINAS Y ARCHIVOS ESTÁTICOS (CON PROTECCIÓN /login)
    // ==========================================

    if (pathname === '/login' || pathname === '/login/') {
      if (isAdminAuthenticated(req)) {
        res.writeHead(302, { Location: '/admin' });
        return res.end();
      }
      const buf = getStaticFile(path.join(PUBLIC_DIR, 'login.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(buf);
    }

    if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin.html') {
      if (!isAdminAuthenticated(req)) {
        res.writeHead(302, { Location: '/login' });
        return res.end();
      }
      const buf = getStaticFile(path.join(PUBLIC_DIR, 'admin.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(buf);
    }

    let filePath = pathname;
    if (filePath === '/' || filePath === '/asistencia') {
      filePath = '/index.html';
    }

    const safePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(PUBLIC_DIR, safePath);
    const buf = getStaticFile(fullPath);

    if (buf) {
      const ext = path.extname(fullPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(buf);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 - Página no encontrada');
    }
  } catch (err) {
    console.error('Error en servidor:', err);
    sendJson(res, 500, {
      ok: false,
      mensaje: err.message || 'Error interno del servidor',
    });
  }
};

const server = http.createServer(requestHandler);

if (!process.env.VERCEL) {
  setInterval(() => {
    triggerBackgroundSyncIfNeeded();
  }, 60000);

  server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIPv4();
    console.log('============================================================');
    console.log('  SISTEMA DE ASISTENCIA Y HORAS ACUMULADAS - AUDITORIO');
    console.log('============================================================');
    console.log(`  Formulario Asistentes (QR):  http://${ip}:${PORT}`);
    console.log(`  Login Administrador:         http://localhost:${PORT}/login`);
    console.log(`  Panel Administrador:         http://localhost:${PORT}/admin`);
    console.log('  Credenciales por defecto:    usuario: admin | clave: congreso2026');
    console.log('============================================================');
  });
}

module.exports = requestHandler;
