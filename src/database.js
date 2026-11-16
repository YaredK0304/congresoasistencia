const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { cleanDNI } = require('./excel');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'asistencia_congreso.db');
const db = new DatabaseSync(DB_PATH);

// Optimización SQLite para alta concurrencia (cientos de peticiones simultáneas sin bloqueo)
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA cache_size = -64000;
  PRAGMA temp_store = MEMORY;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS config (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS participantes (
    dni TEXT PRIMARY KEY,
    nombres TEXT NOT NULL,
    nombres_norm TEXT DEFAULT '',
    datos_extra TEXT DEFAULT '{}',
    origen TEXT DEFAULT 'FORMS',
    creado_en TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sesiones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dni TEXT NOT NULL,
    fecha TEXT NOT NULL,
    hora_entrada TEXT NOT NULL,
    hora_salida TEXT DEFAULT NULL,
    minutos INTEGER DEFAULT 0,
    ts_entrada INTEGER NOT NULL,
    ts_salida INTEGER DEFAULT NULL,
    nota TEXT DEFAULT '',
    FOREIGN KEY (dni) REFERENCES participantes(dni) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sesiones_dni_fecha ON sesiones(dni, fecha);
  CREATE INDEX IF NOT EXISTS idx_sesiones_fecha ON sesiones(fecha);
  CREATE INDEX IF NOT EXISTS idx_sesiones_abiertas ON sesiones(dni, hora_salida);
`);

// Migración segura si la base de datos ya existía de una versión previa
const colsPart = db.prepare('PRAGMA table_info(participantes)').all().map((c) => c.name);
if (!colsPart.includes('nombres_norm')) {
  db.exec("ALTER TABLE participantes ADD COLUMN nombres_norm TEXT DEFAULT ''");
}
if (!colsPart.includes('datos_extra')) {
  db.exec("ALTER TABLE participantes ADD COLUMN datos_extra TEXT DEFAULT '{}'");
}
db.exec('CREATE INDEX IF NOT EXISTS idx_participantes_norm ON participantes(nombres_norm);');

function hashPassword(pwd) {
  return crypto.createHash('sha256').update(String(pwd) + '_congreso_salt_v1').digest('hex');
}

function normalizarTexto(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// Asegurar que filas existentes tengan nombres_norm poblado
const sinNorm = db.prepare("SELECT dni, nombres FROM participantes WHERE nombres_norm = '' OR nombres_norm IS NULL").all();
if (sinNorm.length > 0) {
  const updNorm = db.prepare('UPDATE participantes SET nombres_norm = ? WHERE dni = ?');
  db.exec('BEGIN');
  for (const r of sinNorm) {
    updNorm.run(normalizarTexto(r.nombres), r.dni);
  }
  db.exec('COMMIT');
}

const defaultAdminUser = process.env.ADMIN_USER || 'admin';
const defaultAdminPass = process.env.ADMIN_PASS || 'congreso2026';

const defaultConfigs = {
  nombre_evento: 'Congreso Académico - Control de Auditorio',
  subtitulo_evento: 'Registro Oficial de Asistencia y Acumulación de Horas',
  horas_meta_certificado: '10',
  sheets_url: '',
  ultima_sincronizacion: '',
  columnas_forms: '[]',
  admin_user: defaultAdminUser,
  admin_pass_hash: hashPassword(defaultAdminPass),
};

const insertConfigStmt = db.prepare(
  'INSERT OR IGNORE INTO config (clave, valor) VALUES (?, ?)'
);
for (const [k, v] of Object.entries(defaultConfigs)) {
  insertConfigStmt.run(k, v);
}

// ==========================================
// SENTENCIAS PRE-COMPILADAS (ULTRA RÁPIDAS)
// ==========================================

const STMTS = {
  getAllConfig: db.prepare('SELECT clave, valor FROM config'),
  upsertConfig: db.prepare('INSERT OR REPLACE INTO config (clave, valor) VALUES (?, ?)'),
  getParticipanteByDni: db.prepare(
    'SELECT dni, nombres, datos_extra, origen FROM participantes WHERE dni = ?'
  ),
  getParticipanteByNorm: db.prepare(
    'SELECT dni, nombres, datos_extra, origen FROM participantes WHERE nombres_norm = ? LIMIT 1'
  ),
  insertParticipante: db.prepare(
    'INSERT INTO participantes (dni, nombres, nombres_norm, datos_extra, origen, creado_en) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  updateParticipante: db.prepare(
    'UPDATE participantes SET nombres = ?, nombres_norm = ?, datos_extra = ?, origen = ? WHERE dni = ?'
  ),
  countParticipantes: db.prepare('SELECT COUNT(*) as total FROM participantes'),
  getSesionAbiertaAny: db.prepare(
    'SELECT id, fecha, hora_entrada, ts_entrada FROM sesiones WHERE dni = ? AND hora_salida IS NULL ORDER BY id DESC LIMIT 1'
  ),
  getSesionAbiertaHoy: db.prepare(
    'SELECT * FROM sesiones WHERE dni = ? AND fecha = ? AND hora_salida IS NULL ORDER BY id DESC LIMIT 1'
  ),
  getSesionesAbiertasOtroDia: db.prepare(
    'SELECT * FROM sesiones WHERE dni = ? AND fecha != ? AND hora_salida IS NULL'
  ),
  cerrarSesionHuérfana: db.prepare(
    'UPDATE sesiones SET hora_salida = hora_entrada, ts_salida = ts_entrada, minutos = 0, nota = ? WHERE id = ?'
  ),
  getUltimaCerradaHoy: db.prepare(
    'SELECT * FROM sesiones WHERE dni = ? AND fecha = ? AND hora_salida IS NOT NULL ORDER BY id DESC LIMIT 1'
  ),
  insertSesionEntrada: db.prepare(
    'INSERT INTO sesiones (dni, fecha, hora_entrada, ts_entrada, nota) VALUES (?, ?, ?, ?, ?)'
  ),
  updateSesionSalida: db.prepare(
    "UPDATE sesiones SET hora_salida = ?, ts_salida = ?, minutos = ?, nota = CASE WHEN ? != '' THEN ? ELSE nota END WHERE id = ?"
  ),
  getBloquesHoy: db.prepare(
    'SELECT id, fecha, hora_entrada, hora_salida, minutos, nota FROM sesiones WHERE dni = ? AND fecha = ? ORDER BY id ASC'
  ),
  getMinTotalDni: db.prepare(
    'SELECT COALESCE(SUM(minutos), 0) as total FROM sesiones WHERE dni = ? AND hora_salida IS NOT NULL'
  ),
  buscarRapido: db.prepare(`
    SELECT
      p.dni,
      p.nombres,
      p.origen,
      (SELECT id FROM sesiones s1 WHERE s1.dni = p.dni AND s1.hora_salida IS NULL ORDER BY s1.id DESC LIMIT 1) AS abierta_id,
      (SELECT hora_entrada FROM sesiones s2 WHERE s2.dni = p.dni AND s2.hora_salida IS NULL ORDER BY s2.id DESC LIMIT 1) AS abierta_hora,
      COALESCE((SELECT SUM(minutos) FROM sesiones s3 WHERE s3.dni = p.dni AND s3.fecha = ? AND s3.hora_salida IS NOT NULL), 0) AS min_hoy,
      COALESCE((SELECT SUM(minutos) FROM sesiones s4 WHERE s4.dni = p.dni AND s4.hora_salida IS NOT NULL), 0) AS min_total
    FROM participantes p
    WHERE p.dni LIKE ? OR p.nombres_norm LIKE ?
    ORDER BY CASE WHEN p.dni = ? THEN 0 ELSE 1 END, p.nombres ASC
    LIMIT 12
  `),
};

// ==========================================
// UTILIDADES DE FECHA Y HORA
// ==========================================

function getNowLocal(customDateStr, customTimeStr) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const fecha =
    customDateStr ||
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const hora =
    customTimeStr ||
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const horaPartes = hora.split(':');
  const horaCompleta =
    horaPartes.length === 2
      ? `${pad(horaPartes[0])}:${pad(horaPartes[1])}:00`
      : `${pad(horaPartes[0])}:${pad(horaPartes[1])}:${pad(horaPartes[2] || 0)}`;

  const [y, m, d] = fecha.split('-').map(Number);
  const [hh, mm, ss] = horaCompleta.split(':').map(Number);
  const ts = new Date(y, m - 1, d, hh, mm, ss).getTime();

  return { fecha, hora: horaCompleta, ts };
}

function horaToSeconds(horaStr) {
  if (!horaStr) return 0;
  const parts = String(horaStr).split(':').map(Number);
  const h = parts[0] || 0;
  const m = parts[1] || 0;
  const s = parts[2] || 0;
  return h * 3600 + m * 60 + s;
}

function calcularMinutosBloque(horaEntrada, horaSalida) {
  const secIn = horaToSeconds(horaEntrada);
  const secOut = horaToSeconds(horaSalida);
  let diffSec = secOut - secIn;
  if (diffSec < 0) {
    diffSec += 24 * 3600;
  }
  return Math.max(0, Math.round(diffSec / 60));
}

function formatearMinutos(totalMinutos) {
  const mins = Math.max(0, Math.round(Number(totalMinutos) || 0));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function formatearHoraCorta(horaStr) {
  if (!horaStr) return '--:--';
  return String(horaStr).slice(0, 5);
}

// ==========================================
// CONFIGURACIÓN Y CREDENCIALES ADMIN
// ==========================================

function getConfig() {
  const rows = STMTS.getAllConfig.all();
  const cfg = {};
  for (const r of rows) {
    if (r.clave !== 'admin_pass_hash') {
      cfg[r.clave] = r.valor;
    }
  }
  return cfg;
}

function updateConfig(updates) {
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined && v !== null && k !== 'admin_pass_hash') {
      STMTS.upsertConfig.run(k, String(v));
    }
  }
  return getConfig();
}

function verificarCredencialesAdmin(usuario, password) {
  const rows = STMTS.getAllConfig.all();
  const map = {};
  for (const r of rows) map[r.clave] = r.valor;

  const userEsperado = process.env.ADMIN_USER || map.admin_user || 'admin';
  const hashEsperado = process.env.ADMIN_PASS
    ? hashPassword(process.env.ADMIN_PASS)
    : map.admin_pass_hash;

  const userOk = String(usuario || '').trim() === userEsperado;
  const passOk = hashPassword(password) === hashEsperado;
  return userOk && passOk;
}

function cambiarPasswordAdmin(nuevoUsuario, nuevaPassword) {
  if (nuevoUsuario && String(nuevoUsuario).trim()) {
    STMTS.upsertConfig.run('admin_user', String(nuevoUsuario).trim());
  }
  if (nuevaPassword && String(nuevaPassword).length >= 4) {
    STMTS.upsertConfig.run('admin_pass_hash', hashPassword(nuevaPassword));
  }
  return true;
}

// ==========================================
// PARTICIPANTES (VARIABLES DEL GOOGLE FORMS)
// ==========================================

function importarParticipantes(lista, origen = 'FORMS') {
  const nowStr = new Date().toISOString();
  let nuevos = 0;
  let actualizados = 0;

  // Detectar todas las variables adicionales que vienen del Forms
  const colsExtraSet = new Set();
  try {
    const prevCols = JSON.parse(getConfig().columnas_forms || '[]');
    for (const c of prevCols) colsExtraSet.add(c);
  } catch (_) {}

  db.exec('BEGIN');
  try {
    for (const item of lista) {
      const dni = cleanDNI(item.dni);
      const nombres = String(item.nombres || '').replace(/\s+/g, ' ').trim();
      if (!dni || !nombres) continue;

      const norm = normalizarTexto(nombres);
      const extraObj = item.datos_extra && typeof item.datos_extra === 'object' ? item.datos_extra : {};
      for (const k of Object.keys(extraObj)) colsExtraSet.add(k);

      const existente = STMTS.getParticipanteByDni.get(dni);
      if (!existente) {
        STMTS.insertParticipante.run(
          dni,
          nombres,
          norm,
          JSON.stringify(extraObj),
          origen,
          nowStr
        );
        nuevos++;
      } else {
        let prevExtra = {};
        try {
          prevExtra = JSON.parse(existente.datos_extra || '{}');
        } catch (_) {}
        const mergedExtra = { ...prevExtra, ...extraObj };
        const nuevoJson = JSON.stringify(mergedExtra);
        if (existente.nombres !== nombres || existente.datos_extra !== nuevoJson) {
          STMTS.updateParticipante.run(nombres, norm, nuevoJson, origen, dni);
          actualizados++;
        }
      }
    }
    STMTS.upsertConfig.run('columnas_forms', JSON.stringify(Array.from(colsExtraSet)));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const total = STMTS.countParticipantes.get().total;
  return {
    nuevos,
    actualizados,
    total,
    columnas_forms: Array.from(colsExtraSet),
  };
}

function buscarParticipantes(query, fechaActual) {
  const q = String(query || '').trim();
  if (!q) return [];
  const fecha = fechaActual || getNowLocal().fecha;
  const qNorm = normalizarTexto(q);
  const qDigits = cleanDNI(q);

  const rows = STMTS.buscarRapido.all(
    fecha,
    `%${qDigits || q}%`,
    `%${qNorm}%`,
    qDigits || q
  );

  return rows.map((r) => ({
    dni: r.dni,
    nombres: r.nombres,
    origen: r.origen,
    exactDni: r.dni === q || r.dni === qDigits,
    dentro: Boolean(r.abierta_id),
    sesion_abierta: r.abierta_id
      ? { id: r.abierta_id, hora_entrada: r.abierta_hora }
      : null,
    minutos_hoy: r.min_hoy,
    horas_hoy_texto: formatearMinutos(r.min_hoy),
    minutos_total: r.min_total,
    horas_total_texto: formatearMinutos(r.min_total),
  }));
}

function obtenerEstadoParticipante(dniRaw, fechaActual) {
  const dni = cleanDNI(dniRaw);
  if (!dni) return null;
  const fecha = fechaActual || getNowLocal().fecha;
  const p = STMTS.getParticipanteByDni.get(dni);
  if (!p) return null;

  const sesionAbierta = STMTS.getSesionAbiertaAny.get(dni);
  const bloquesHoy = STMTS.getBloquesHoy.all(dni, fecha);

  const minHoy = bloquesHoy.reduce(
    (acc, b) => acc + (b.hora_salida ? Number(b.minutos || 0) : 0),
    0
  );
  const minTotal = STMTS.getMinTotalDni.get(dni).total;

  return {
    participante: {
      dni: p.dni,
      nombres: p.nombres,
      origen: p.origen,
    },
    dentro: Boolean(sesionAbierta),
    sesion_abierta: sesionAbierta || null,
    bloques_hoy: bloquesHoy.map((b) => ({
      ...b,
      hora_entrada_corta: formatearHoraCorta(b.hora_entrada),
      hora_salida_corta: b.hora_salida ? formatearHoraCorta(b.hora_salida) : null,
      duracion_texto: b.hora_salida ? formatearMinutos(b.minutos) : 'En curso',
    })),
    minutos_hoy: minHoy,
    horas_hoy_texto: formatearMinutos(minHoy),
    minutos_total: minTotal,
    horas_total_texto: formatearMinutos(minTotal),
  };
}

// ==========================================
// REGISTRO DE ENTRADA Y SALIDA (SOLO DNI / NOMBRE)
// ==========================================

function registrarMarca({
  dni: rawDni,
  nombres: rawNombres,
  fechaCustom,
  horaCustom,
  forzar = false,
  nota = '',
}) {
  let dni = cleanDNI(rawDni);
  const nombresInput = String(rawNombres || '').replace(/\s+/g, ' ').trim();

  // Si no puso DNI pero puso su nombre, buscarlo por nombre normalizado indexado
  if (!dni && nombresInput) {
    const norm = normalizarTexto(nombresInput);
    const encontrado = STMTS.getParticipanteByNorm.get(norm);
    if (encontrado) {
      dni = encontrado.dni;
    }
  }

  if (!dni) {
    return {
      ok: false,
      codigo: 'FALTA_DNI',
      mensaje: 'Por favor ingresa tu número de DNI o selecciona tu nombre de la lista.',
    };
  }

  let participante = STMTS.getParticipanteByDni.get(dni);

  if (!participante) {
    if (!nombresInput) {
      return {
        ok: false,
        codigo: 'NO_ENCONTRADO_PEDIR_NOMBRE',
        dni,
        mensaje:
          'No encontramos este DNI en la lista previa del Forms. Escribe tus Nombres y Apellidos para registrarte ahora mismo.',
      };
    }
    const norm = normalizarTexto(nombresInput);
    STMTS.insertParticipante.run(
      dni,
      nombresInput,
      norm,
      '{}',
      'PUERTA',
      new Date().toISOString()
    );
    participante = { dni, nombres: nombresInput, origen: 'PUERTA' };
  }

  const { fecha, hora, ts } = getNowLocal(fechaCustom, horaCustom);

  const sesionAbiertaHoy = STMTS.getSesionAbiertaHoy.get(dni, fecha);

  // Cerrar sesiones olvidadas de días anteriores
  const sesionAbiertaAnterior = STMTS.getSesionesAbiertasOtroDia.all(dni, fecha);
  for (const ant of sesionAbiertaAnterior) {
    STMTS.cerrarSesionHuérfana.run('Cerrado automático (día anterior)', ant.id);
  }

  if (!sesionAbiertaHoy) {
    if (!forzar && !fechaCustom && !horaCustom) {
      const ultimaCerrada = STMTS.getUltimaCerradaHoy.get(dni, fecha);
      if (ultimaCerrada && ultimaCerrada.ts_salida && Math.abs(ts - ultimaCerrada.ts_salida) < 45000) {
        return {
          ok: false,
          codigo: 'CONFIRMAR_REINGRESO_RAPIDO',
          tipo_sugerido: 'ENTRADA',
          participante: { dni: participante.dni, nombres: participante.nombres },
          ultima_hora: formatearHoraCorta(ultimaCerrada.hora_salida),
          mensaje: `Acabas de registrar tu SALIDA hace unos segundos (${formatearHoraCorta(
            ultimaCerrada.hora_salida
          )}). ¿Deseas abrir una nueva ENTRADA ahora mismo?`,
        };
      }
    }

    const info = STMTS.insertSesionEntrada.run(dni, fecha, hora, ts, nota);
    const estado = obtenerEstadoParticipante(dni, fecha);
    return {
      ok: true,
      tipo: 'ENTRADA',
      mensaje: '¡Entrada registrada correctamente!',
      fecha,
      hora_marca: formatearHoraCorta(hora),
      hora_completa: hora,
      bloque_id: info.lastInsertRowid,
      numero_bloque_hoy: estado.bloques_hoy.length,
      ...estado,
    };
  } else {
    if (!forzar && !fechaCustom && !horaCustom && Math.abs(ts - sesionAbiertaHoy.ts_entrada) < 45000) {
      return {
        ok: false,
        codigo: 'CONFIRMAR_SALIDA_RAPIDA',
        tipo_sugerido: 'SALIDA',
        participante: { dni: participante.dni, nombres: participante.nombres },
        ultima_hora: formatearHoraCorta(sesionAbiertaHoy.hora_entrada),
        mensaje: `Acabas de registrar tu ENTRADA hace unos segundos (${formatearHoraCorta(
          sesionAbiertaHoy.hora_entrada
        )}). ¿Seguro que deseas registrar tu SALIDA ahora mismo?`,
      };
    }

    const minutosBloque = calcularMinutosBloque(sesionAbiertaHoy.hora_entrada, hora);
    STMTS.updateSesionSalida.run(hora, ts, minutosBloque, nota, nota, sesionAbiertaHoy.id);

    const estado = obtenerEstadoParticipante(dni, fecha);
    return {
      ok: true,
      tipo: 'SALIDA',
      mensaje: '¡Salida registrada correctamente!',
      fecha,
      hora_entrada_bloque: formatearHoraCorta(sesionAbiertaHoy.hora_entrada),
      hora_marca: formatearHoraCorta(hora),
      hora_completa: hora,
      minutos_bloque: minutosBloque,
      horas_bloque_texto: formatearMinutos(minutosBloque),
      bloque_id: sesionAbiertaHoy.id,
      numero_bloque_hoy: estado.bloques_hoy.length,
      ...estado,
    };
  }
}

// ==========================================
// FUNCIONES DE ADMINISTRACIÓN Y REPORTES
// ==========================================

function registrarBloqueManual({ dni: rawDni, nombres, fecha, hora_entrada, hora_salida, nota = '' }) {
  const dni = cleanDNI(rawDni);
  if (!dni || !fecha || !hora_entrada) {
    throw new Error('DNI, fecha y hora de entrada son obligatorios');
  }

  const p = STMTS.getParticipanteByDni.get(dni);
  if (!p) {
    const nom = String(nombres || `Participante ${dni}`).trim();
    STMTS.insertParticipante.run(
      dni,
      nom,
      normalizarTexto(nom),
      '{}',
      'MANUAL',
      new Date().toISOString()
    );
  }

  const entradaNorm = hora_entrada.length === 5 ? `${hora_entrada}:00` : hora_entrada;
  const tsEntrada = getNowLocal(fecha, entradaNorm).ts;

  if (hora_salida) {
    const salidaNorm = hora_salida.length === 5 ? `${hora_salida}:00` : hora_salida;
    const tsSalida = getNowLocal(fecha, salidaNorm).ts;
    const minutos = calcularMinutosBloque(entradaNorm, salidaNorm);
    db.prepare(
      'INSERT INTO sesiones (dni, fecha, hora_entrada, hora_salida, minutos, ts_entrada, ts_salida, nota) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(dni, fecha, entradaNorm, salidaNorm, minutos, tsEntrada, tsSalida, nota || 'Registro manual');
  } else {
    STMTS.insertSesionEntrada.run(dni, fecha, entradaNorm, tsEntrada, nota || 'Entrada manual');
  }

  return obtenerEstadoParticipante(dni, fecha);
}

function actualizarBloque(id, { fecha, hora_entrada, hora_salida, nota }) {
  const sesion = db.prepare('SELECT * FROM sesiones WHERE id = ?').get(id);
  if (!sesion) throw new Error('Sesión no encontrada');

  const nuevaFecha = fecha || sesion.fecha;
  const nuevaEntrada = hora_entrada
    ? hora_entrada.length === 5
      ? `${hora_entrada}:00`
      : hora_entrada
    : sesion.hora_entrada;
  const tsEntrada = getNowLocal(nuevaFecha, nuevaEntrada).ts;

  let nuevaSalida = null;
  let tsSalida = null;
  let minutos = 0;

  if (hora_salida && String(hora_salida).trim() !== '') {
    nuevaSalida = hora_salida.length === 5 ? `${hora_salida}:00` : hora_salida;
    tsSalida = getNowLocal(nuevaFecha, nuevaSalida).ts;
    minutos = calcularMinutosBloque(nuevaEntrada, nuevaSalida);
  }

  db.prepare(
    'UPDATE sesiones SET fecha = ?, hora_entrada = ?, hora_salida = ?, minutos = ?, ts_entrada = ?, ts_salida = ?, nota = ? WHERE id = ?'
  ).run(
    nuevaFecha,
    nuevaEntrada,
    nuevaSalida,
    minutos,
    tsEntrada,
    tsSalida,
    nota !== undefined ? nota : sesion.nota,
    id
  );
  return true;
}

function eliminarBloque(id) {
  db.prepare('DELETE FROM sesiones WHERE id = ?').run(id);
  return true;
}

function cerrarSesionesAbiertas({ fecha, hora_cierre }) {
  const horaNorm =
    hora_cierre && hora_cierre.length === 5 ? `${hora_cierre}:00` : hora_cierre || getNowLocal().hora;

  const abiertas = fecha
    ? db.prepare('SELECT * FROM sesiones WHERE fecha = ? AND hora_salida IS NULL').all(fecha)
    : db.prepare('SELECT * FROM sesiones WHERE hora_salida IS NULL').all();

  const updateStmt = db.prepare(
    'UPDATE sesiones SET hora_salida = ?, ts_salida = ?, minutos = ?, nota = ? WHERE id = ?'
  );

  let cerradas = 0;
  db.exec('BEGIN');
  try {
    for (const s of abiertas) {
      const minutos = calcularMinutosBloque(s.hora_entrada, horaNorm);
      const tsOut = getNowLocal(s.fecha, horaNorm).ts;
      updateStmt.run(
        horaNorm,
        tsOut,
        minutos,
        s.nota
          ? `${s.nota} | Cierre grupal (${formatearHoraCorta(horaNorm)})`
          : `Cierre grupal (${formatearHoraCorta(horaNorm)})`,
        s.id
      );
      cerradas++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { cerradas, hora_cierre: formatearHoraCorta(horaNorm) };
}

function obtenerResumenGeneral() {
  const config = getConfig();
  const hoy = getNowLocal().fecha;
  const metaHoras = parseFloat(config.horas_meta_certificado || '0') || 0;
  const metaMinutos = metaHoras * 60;

  let columnasForms = [];
  try {
    columnasForms = JSON.parse(config.columnas_forms || '[]');
  } catch (_) {}

  const participantes = db
    .prepare(
      'SELECT dni, nombres, datos_extra, origen, creado_en FROM participantes ORDER BY nombres ASC'
    )
    .all();

  const sesiones = db
    .prepare(
      `SELECT s.*, p.nombres
       FROM sesiones s
       LEFT JOIN participantes p ON p.dni = s.dni
       ORDER BY s.fecha ASC, s.hora_entrada ASC`
    )
    .all();

  const fechasSet = new Set();
  for (const s of sesiones) fechasSet.add(s.fecha);
  const fechasOrdenadas = Array.from(fechasSet).sort();

  const porDni = new Map();
  for (const p of participantes) {
    let extra = {};
    try {
      extra = JSON.parse(p.datos_extra || '{}');
    } catch (_) {}
    porDni.set(p.dni, {
      dni: p.dni,
      nombres: p.nombres,
      datos_extra: extra,
      origen: p.origen,
      dentro: false,
      sesion_abierta: null,
      minutos_total: 0,
      minutos_hoy: 0,
      por_fecha: {},
      bloques: [],
    });
  }

  const dentroAhora = [];

  for (const s of sesiones) {
    if (!porDni.has(s.dni)) {
      porDni.set(s.dni, {
        dni: s.dni,
        nombres: s.nombres || `DNI ${s.dni}`,
        datos_extra: {},
        origen: 'PUERTA',
        dentro: false,
        sesion_abierta: null,
        minutos_total: 0,
        minutos_hoy: 0,
        por_fecha: {},
        bloques: [],
      });
    }
    const item = porDni.get(s.dni);
    if (!item.por_fecha[s.fecha]) {
      item.por_fecha[s.fecha] = {
        minutos: 0,
        bloques: [],
      };
    }

    const bloqueInfo = {
      id: s.id,
      fecha: s.fecha,
      hora_entrada: formatearHoraCorta(s.hora_entrada),
      hora_salida: s.hora_salida ? formatearHoraCorta(s.hora_salida) : null,
      minutos: s.hora_salida ? Number(s.minutos || 0) : 0,
      duracion_texto: s.hora_salida ? formatearMinutos(s.minutos) : 'En curso',
      en_curso: !s.hora_salida,
      nota: s.nota || '',
    };

    item.bloques.push(bloqueInfo);
    item.por_fecha[s.fecha].bloques.push(bloqueInfo);

    if (s.hora_salida) {
      const m = Number(s.minutos || 0);
      item.minutos_total += m;
      item.por_fecha[s.fecha].minutos += m;
      if (s.fecha === hoy) item.minutos_hoy += m;
    } else {
      item.dentro = true;
      item.sesion_abierta = {
        id: s.id,
        fecha: s.fecha,
        hora_entrada: formatearHoraCorta(s.hora_entrada),
        ts_entrada: s.ts_entrada,
      };
      dentroAhora.push({
        id: s.id,
        dni: s.dni,
        nombres: item.nombres,
        fecha: s.fecha,
        hora_entrada: formatearHoraCorta(s.hora_entrada),
        ts_entrada: s.ts_entrada,
      });
    }
  }

  const listaParticipantes = Array.from(porDni.values()).map((item) => {
    const porFechaFormateado = {};
    for (const f of fechasOrdenadas) {
      const datosF = item.por_fecha[f] || { minutos: 0, bloques: [] };
      porFechaFormateado[f] = {
        minutos: datosF.minutos,
        horas_texto: formatearMinutos(datosF.minutos),
        horas_decimal: Number((datosF.minutos / 60).toFixed(2)),
        resumen_bloques: datosF.bloques
          .map((b) =>
            b.en_curso
              ? `${b.hora_entrada} → En sala`
              : `${b.hora_entrada}-${b.hora_salida} (${formatearMinutos(b.minutos)})`
          )
          .join(' | '),
        bloques: datosF.bloques,
      };
    }

    return {
      dni: item.dni,
      nombres: item.nombres,
      datos_extra: item.datos_extra || {},
      origen: item.origen,
      dentro: item.dentro,
      sesion_abierta: item.sesion_abierta,
      minutos_hoy: item.minutos_hoy,
      horas_hoy_texto: formatearMinutos(item.minutos_hoy),
      minutos_total: item.minutos_total,
      horas_total_texto: formatearMinutos(item.minutos_total),
      horas_total_decimal: Number((item.minutos_total / 60).toFixed(2)),
      cumple_meta: metaMinutos > 0 ? item.minutos_total >= metaMinutos : true,
      total_bloques: item.bloques.length,
      por_fecha: porFechaFormateado,
      bloques: item.bloques,
    };
  });

  const ultimosMovimientos = db
    .prepare(
      `SELECT s.*, p.nombres
       FROM sesiones s
       LEFT JOIN participantes p ON p.dni = s.dni
       ORDER BY COALESCE(s.ts_salida, s.ts_entrada) DESC
       LIMIT 25`
    )
    .all()
    .map((s) => ({
      id: s.id,
      dni: s.dni,
      nombres: s.nombres || `DNI ${s.dni}`,
      fecha: s.fecha,
      tipo: s.hora_salida ? 'SALIDA' : 'ENTRADA',
      hora_entrada: formatearHoraCorta(s.hora_entrada),
      hora_salida: s.hora_salida ? formatearHoraCorta(s.hora_salida) : null,
      hora_evento: formatearHoraCorta(s.hora_salida || s.hora_entrada),
      minutos: s.minutos,
      duracion_texto: s.hora_salida ? formatearMinutos(s.minutos) : 'En auditorio',
    }));

  const totalMinutosCongreso = listaParticipantes.reduce((acc, p) => acc + p.minutos_total, 0);
  const asistentesConRegistro = listaParticipantes.filter((p) => p.total_bloques > 0).length;

  return {
    config,
    hoy,
    fechas: fechasOrdenadas,
    columnas_forms: columnasForms,
    metricas: {
      total_inscritos: listaParticipantes.length,
      dentro_ahora: dentroAhora.length,
      asistentes_con_registro: asistentesConRegistro,
      total_bloques: sesiones.length,
      total_horas_acumuladas: formatearMinutos(totalMinutosCongreso),
    },
    dentro_ahora: dentroAhora,
    ultimos_movimientos: ultimosMovimientos,
    participantes: listaParticipantes,
  };
}

function cargarDatosEjemplo() {
  const demoParticipantes = [
    { dni: '72345678', nombres: 'Ana María Quispe Rojas' },
    { dni: '45891234', nombres: 'Carlos Eduardo Mendoza Vargas' },
    { dni: '70981234', nombres: 'Lucía Fernanda Salazar Paredes' },
    { dni: '48126790', nombres: 'Jorge Luis Huamán Castillo' },
    { dni: '74125896', nombres: 'Valeria Sofía Torres Chávez' },
  ];

  importarParticipantes(demoParticipantes, 'FORMS');

  const delStmt = db.prepare('DELETE FROM sesiones WHERE dni = ?');
  for (const p of demoParticipantes) delStmt.run(p.dni);

  registrarBloqueManual({
    dni: '72345678',
    fecha: '2026-11-16',
    hora_entrada: '08:00',
    hora_salida: '11:00',
    nota: 'Turno Mañana Lunes',
  });
  registrarBloqueManual({
    dni: '72345678',
    fecha: '2026-11-16',
    hora_entrada: '15:00',
    hora_salida: '17:30',
    nota: 'Turno Tarde Lunes (post-refrigerio)',
  });
  registrarBloqueManual({
    dni: '72345678',
    fecha: '2026-11-17',
    hora_entrada: '08:00',
    hora_salida: '11:00',
    nota: 'Turno Mañana Martes',
  });
  registrarBloqueManual({
    dni: '72345678',
    fecha: '2026-11-17',
    hora_entrada: '15:00',
    hora_salida: '18:00',
    nota: 'Turno Tarde Martes',
  });

  registrarBloqueManual({
    dni: '45891234',
    fecha: '2026-11-16',
    hora_entrada: '08:15',
    hora_salida: '11:00',
    nota: 'Turno Mañana Lunes',
  });
  registrarBloqueManual({
    dni: '45891234',
    fecha: '2026-11-16',
    hora_entrada: '15:00',
    hora_salida: '17:00',
    nota: 'Turno Tarde Lunes',
  });
  registrarBloqueManual({
    dni: '45891234',
    fecha: '2026-11-17',
    hora_entrada: '08:00',
    hora_salida: '11:00',
    nota: 'Turno Mañana Martes',
  });

  registrarBloqueManual({
    dni: '70981234',
    fecha: '2026-11-16',
    hora_entrada: '08:00',
    hora_salida: '11:00',
    nota: 'Turno Mañana Lunes',
  });

  return obtenerResumenGeneral();
}

function limpiarTodo({ incluirParticipantes = false }) {
  db.prepare('DELETE FROM sesiones').run();
  if (incluirParticipantes) {
    db.prepare('DELETE FROM participantes').run();
    STMTS.upsertConfig.run('columnas_forms', '[]');
  }
  return obtenerResumenGeneral();
}

module.exports = {
  getConfig,
  updateConfig,
  verificarCredencialesAdmin,
  cambiarPasswordAdmin,
  importarParticipantes,
  buscarParticipantes,
  obtenerEstadoParticipante,
  registrarMarca,
  registrarBloqueManual,
  actualizarBloque,
  eliminarBloque,
  cerrarSesionesAbiertas,
  obtenerResumenGeneral,
  cargarDatosEjemplo,
  limpiarTodo,
  formatearMinutos,
};
