
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { cleanDNI } = require('./excel');

function resolveDataDir() {
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return process.env.RAILWAY_VOLUME_MOUNT_PATH;
  }
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return path.join(os.tmpdir(), 'congreso_data');
  }
  const localDir = path.join(__dirname, '..', 'data');
  try {
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    const testFile = path.join(localDir, '.write_test');
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return localDir;
  } catch (_) {
    return path.join(os.tmpdir(), 'congreso_data');
  }
}

const DATA_DIR = resolveDataDir();
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch (_) { }

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

const defaultAdminUser = process.env.ADMIN_USER || 'admin';
const defaultAdminPass = process.env.ADMIN_PASS || 'congreso2026';

const defaultConfigs = {
  nombre_evento: 'Congreso Académico - Control de Auditorio',
  subtitulo_evento: 'Registro Oficial de Asistencia y Acumulación de Horas',
  horas_meta_certificado: '10',
  sheets_url: 'https://docs.google.com/spreadsheets/d/1Hyxd3dC5cESDKQ39TIPYFYToI20PxA24JHd2ik2-ZDs/edit?usp=sharing',
  ultima_sincronizacion: '',
  columnas_forms: '[]',
  admin_user: defaultAdminUser,
  admin_pass_hash: hashPassword(defaultAdminPass),
};

// ==========================================
// MOTOR DE ALMACENAMIENTO HÍBRIDO:
// Usa node:sqlite en Node 22.5+ y cae automáticamente a JSON/RAM en Vercel (Node 18/20 o Serverless)
// ==========================================

const JSON_FILE = path.join(DATA_DIR, 'asistencia_congreso.json');

let store = {
  config: { ...defaultConfigs },
  participantes: {}, // dni -> { dni, nombres, nombres_norm, datos_extra, origen, creado_en }
  sesiones: [], // [{ id, dni, fecha, hora_entrada, hora_salida, minutos, ts_entrada, ts_salida, nota }]
  nextId: 1,
};

function loadStoreFromDisk() {
  try {
    if (fs.existsSync(JSON_FILE)) {
      const raw = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        store.config = { ...defaultConfigs, ...(raw.config || {}) };
        store.participantes = raw.participantes || {};
        store.sesiones = Array.isArray(raw.sesiones) ? raw.sesiones : [];
        store.nextId = Number(raw.nextId) || store.sesiones.length + 1;
      }
    }
  } catch (_) { }
}

function saveStoreToDisk() {
  try {
    fs.writeFileSync(JSON_FILE, JSON.stringify(store), 'utf8');
  } catch (_) { }
}

loadStoreFromDisk();

// Intentar también sincronizar con SQLite si el entorno tiene node:sqlite (Node 22.5+)
let sqliteDb = null;
try {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(DATA_DIR, 'asistencia_congreso.db');
  sqliteDb = new DatabaseSync(dbPath);
  try {
    sqliteDb.exec('PRAGMA journal_mode = WAL;');
  } catch (_) { }
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS config (clave TEXT PRIMARY KEY, valor TEXT NOT NULL);
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
      nota TEXT DEFAULT ''
    );
  `);

  // Si JSON estaba vacío pero SQLite tenía datos previos, cargar desde SQLite a memoria
  if (Object.keys(store.participantes).length === 0) {
    const cfgRows = sqliteDb.prepare('SELECT clave, valor FROM config').all();
    for (const r of cfgRows) store.config[r.clave] = r.valor;

    const partRows = sqliteDb.prepare('SELECT * FROM participantes').all();
    for (const p of partRows) {
      let extra = {};
      try {
        extra = typeof p.datos_extra === 'string' ? JSON.parse(p.datos_extra || '{}') : p.datos_extra || {};
      } catch (_) { }
      store.participantes[p.dni] = {
        dni: p.dni,
        nombres: p.nombres,
        nombres_norm: p.nombres_norm || normalizarTexto(p.nombres),
        datos_extra: extra,
        origen: p.origen || 'FORMS',
        creado_en: p.creado_en || new Date().toISOString(),
      };
    }

    const sesRows = sqliteDb.prepare('SELECT * FROM sesiones ORDER BY id ASC').all();
    store.sesiones = sesRows.map((s) => ({
      id: Number(s.id),
      dni: s.dni,
      fecha: s.fecha,
      hora_entrada: s.hora_entrada,
      hora_salida: s.hora_salida || null,
      minutos: Number(s.minutos || 0),
      ts_entrada: Number(s.ts_entrada || 0),
      ts_salida: s.ts_salida ? Number(s.ts_salida) : null,
      nota: s.nota || '',
    }));
    const maxId = store.sesiones.reduce((m, s) => Math.max(m, s.id), 0);
    store.nextId = maxId + 1;
    saveStoreToDisk();
  }
} catch (_) {
  sqliteDb = null;
}

// ==========================================
// UTILIDADES DE FECHA Y HORA (HORA PERÚ UTC-5)
// ==========================================

function getNowLocal(customDateStr, customTimeStr) {
  const peruDate = new Date(Date.now() - 5 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const fecha =
    customDateStr ||
    `${peruDate.getUTCFullYear()}-${pad(peruDate.getUTCMonth() + 1)}-${pad(
      peruDate.getUTCDate()
    )}`;
  const hora =
    customTimeStr ||
    `${pad(peruDate.getUTCHours())}:${pad(peruDate.getUTCMinutes())}:${pad(
      peruDate.getUTCSeconds()
    )}`;
  const horaPartes = hora.split(':');
  const horaCompleta =
    horaPartes.length === 2
      ? `${pad(horaPartes[0])}:${pad(horaPartes[1])}:00`
      : `${pad(horaPartes[0])}:${pad(horaPartes[1])}:${pad(horaPartes[2] || 0)}`;

  const [y, m, d] = fecha.split('-').map(Number);
  const [hh, mm, ss] = horaCompleta.split(':').map(Number);
  const ts = Date.UTC(y, m - 1, d, hh + 5, mm, ss);

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
  const cfg = { ...store.config };
  delete cfg.admin_pass_hash;
  return cfg;
}

function updateConfig(updates) {
  for (const [k, v] of Object.entries(updates || {})) {
    if (v !== undefined && v !== null && k !== 'admin_pass_hash') {
      store.config[k] = String(v);
    }
  }
  saveStoreToDisk();
  return getConfig();
}

function verificarCredencialesAdmin(usuario, password) {
  const userEsperado = process.env.ADMIN_USER || store.config.admin_user || 'admin';
  const hashEsperado = process.env.ADMIN_PASS
    ? hashPassword(process.env.ADMIN_PASS)
    : store.config.admin_pass_hash || hashPassword('congreso2026');

  const userOk = String(usuario || '').trim() === userEsperado;
  const passOk = hashPassword(password) === hashEsperado;
  return userOk && passOk;
}

function cambiarPasswordAdmin(nuevoUsuario, nuevaPassword) {
  if (nuevoUsuario && String(nuevoUsuario).trim()) {
    store.config.admin_user = String(nuevoUsuario).trim();
  }
  if (nuevaPassword && String(nuevaPassword).length >= 4) {
    store.config.admin_pass_hash = hashPassword(nuevaPassword);
  }
  saveStoreToDisk();
  return true;
}

// ==========================================
// PARTICIPANTES (VARIABLES DEL GOOGLE FORMS)
// ==========================================

function importarParticipantes(lista, origen = 'FORMS') {
  const nowStr = new Date().toISOString();
  let nuevos = 0;
  let actualizados = 0;

  const colsExtraSet = new Set();
  try {
    const prevCols = JSON.parse(store.config.columnas_forms || '[]');
    for (const c of prevCols) colsExtraSet.add(c);
  } catch (_) { }

  for (const item of lista || []) {
    const dni = cleanDNI(item.dni);
    const nombres = String(item.nombres || '').replace(/\s+/g, ' ').trim();
    if (!dni || !nombres) continue;

    const norm = normalizarTexto(nombres);
    const extraObj =
      item.datos_extra && typeof item.datos_extra === 'object' ? item.datos_extra : {};
    for (const k of Object.keys(extraObj)) colsExtraSet.add(k);

    const existente = store.participantes[dni];
    if (!existente) {
      store.participantes[dni] = {
        dni,
        nombres,
        nombres_norm: norm,
        datos_extra: extraObj,
        origen,
        creado_en: nowStr,
      };
      nuevos++;
    } else {
      const mergedExtra = { ...(existente.datos_extra || {}), ...extraObj };
      const changed =
        existente.nombres !== nombres ||
        JSON.stringify(existente.datos_extra || {}) !== JSON.stringify(mergedExtra);
      existente.nombres = nombres;
      existente.nombres_norm = norm;
      existente.datos_extra = mergedExtra;
      existente.origen = origen;
      if (changed) actualizados++;
    }
  }

  store.config.columnas_forms = JSON.stringify(Array.from(colsExtraSet));
  saveStoreToDisk();

  return {
    nuevos,
    actualizados,
    total: Object.keys(store.participantes).length,
    columnas_forms: Array.from(colsExtraSet),
  };
}

function buscarParticipantes(query, fechaActual) {
  const q = String(query || '').trim();
  if (!q) return [];
  const fecha = fechaActual || getNowLocal().fecha;
  const qNorm = normalizarTexto(q);
  const qDigits = cleanDNI(q);

  const resultados = [];
  for (const p of Object.values(store.participantes)) {
    const matchDni =
      p.dni.includes(q) || (qDigits.length >= 2 && p.dni.includes(qDigits));
    const matchNombre = p.nombres_norm.includes(qNorm);
    if (matchDni || matchNombre) {
      let abierta = null;
      let minHoy = 0;
      let minTotal = 0;
      for (const s of store.sesiones) {
        if (s.dni !== p.dni) continue;
        if (!s.hora_salida) {
          abierta = s;
        } else {
          minTotal += Number(s.minutos || 0);
          if (s.fecha === fecha) minHoy += Number(s.minutos || 0);
        }
      }
      resultados.push({
        dni: p.dni,
        nombres: p.nombres,
        origen: p.origen,
        exactDni: p.dni === q || p.dni === qDigits,
        dentro: Boolean(abierta),
        sesion_abierta: abierta
          ? { id: abierta.id, hora_entrada: formatearHoraCorta(abierta.hora_entrada) }
          : null,
        minutos_hoy: minHoy,
        horas_hoy_texto: formatearMinutos(minHoy),
        minutos_total: minTotal,
        horas_total_texto: formatearMinutos(minTotal),
      });
    }
  }

  resultados.sort((a, b) => {
    if (a.exactDni !== b.exactDni) return (b.exactDni ? 1 : 0) - (a.exactDni ? 1 : 0);
    return a.nombres.localeCompare(b.nombres);
  });
  return resultados.slice(0, 12);
}

function obtenerEstadoParticipante(dniRaw, fechaActual) {
  const dni = cleanDNI(dniRaw);
  if (!dni) return null;
  const fecha = fechaActual || getNowLocal().fecha;
  const p = store.participantes[dni];
  if (!p) return null;

  let sesionAbierta = null;
  const bloquesHoy = [];
  let minHoy = 0;
  let minTotal = 0;

  for (const s of store.sesiones) {
    if (s.dni !== dni) continue;
    if (!s.hora_salida) {
      sesionAbierta = s;
    } else {
      minTotal += Number(s.minutos || 0);
    }
    if (s.fecha === fecha) {
      if (s.hora_salida) minHoy += Number(s.minutos || 0);
      bloquesHoy.push({
        ...s,
        hora_entrada_corta: formatearHoraCorta(s.hora_entrada),
        hora_salida_corta: s.hora_salida ? formatearHoraCorta(s.hora_salida) : null,
        duracion_texto: s.hora_salida ? formatearMinutos(s.minutos) : 'En curso',
      });
    }
  }

  return {
    participante: {
      dni: p.dni,
      nombres: p.nombres,
      origen: p.origen,
    },
    dentro: Boolean(sesionAbierta),
    sesion_abierta: sesionAbierta || null,
    bloques_hoy: bloquesHoy,
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
  correo: rawCorreo,
  fechaCustom,
  horaCustom,
  forzar = false,
  nota = '',
  sesion_previa = null,
}) {
  let dni = cleanDNI(rawDni);
  const nombresInput = String(rawNombres || '').replace(/\s+/g, ' ').trim();
  const correoInput = String(rawCorreo || '').trim();

  if (!dni && nombresInput) {
    const norm = normalizarTexto(nombresInput);
    const encontrado = Object.values(store.participantes).find(
      (p) => p.nombres_norm === norm
    );
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

  let participante = store.participantes[dni];
  if (!participante) {
    if (!nombresInput) {
      return {
        ok: false,
        codigo: 'NO_ENCONTRADO_PEDIR_NOMBRE',
        dni,
        mensaje:
          'No encontramos este DNI en la lista previa del Forms. Escribe tus Nombres y Apellidos y tu Correo para registrarte ahora mismo.',
      };
    }
    const extraNuevo = {};
    if (correoInput) {
      extraNuevo['Correo electrónico'] = correoInput;
    }
    participante = {
      dni,
      nombres: nombresInput,
      nombres_norm: normalizarTexto(nombresInput),
      datos_extra: extraNuevo,
      origen: 'PUERTA',
      creado_en: new Date().toISOString(),
    };
    store.participantes[dni] = participante;
  } else if (correoInput) {
    participante.datos_extra = participante.datos_extra || {};
    participante.datos_extra['Correo electrónico'] = correoInput;
  }

  const { fecha, hora, ts } = getNowLocal(fechaCustom, horaCustom);

  // Si esta instancia no tenía aún la entrada previa pero el dispositivo del asistente sí la trae
  if (
    sesion_previa &&
    sesion_previa.dni === dni &&
    sesion_previa.fecha === fecha &&
    sesion_previa.hora_entrada &&
    !store.sesiones.some((s) => s.dni === dni && s.fecha === fecha && !s.hora_salida)
  ) {
    const hInPrev =
      sesion_previa.hora_entrada.length === 5
        ? `${sesion_previa.hora_entrada}:00`
        : sesion_previa.hora_entrada;
    store.sesiones.push({
      id: store.nextId++,
      dni,
      fecha,
      hora_entrada: hInPrev,
      hora_salida: null,
      minutos: 0,
      ts_entrada: getNowLocal(fecha, hInPrev).ts,
      ts_salida: null,
      nota: 'Sincronizado desde dispositivo',
    });
  }

  // Cerrar sesiones olvidadas de días anteriores
  let sesionAbiertaHoy = null;
  let ultimaCerradaHoy = null;

  for (const s of store.sesiones) {
    if (s.dni !== dni) continue;
    if (!s.hora_salida) {
      if (s.fecha === fecha) {
        sesionAbiertaHoy = s;
      } else {
        s.hora_salida = s.hora_entrada;
        s.ts_salida = s.ts_entrada;
        s.minutos = 0;
        s.nota = 'Cerrado automático (día anterior)';
      }
    } else if (s.fecha === fecha) {
      ultimaCerradaHoy = s;
    }
  }

  if (!sesionAbiertaHoy) {
    if (
      !forzar &&
      !fechaCustom &&
      !horaCustom &&
      ultimaCerradaHoy &&
      ultimaCerradaHoy.ts_salida &&
      Math.abs(ts - ultimaCerradaHoy.ts_salida) < 45000
    ) {
      return {
        ok: false,
        codigo: 'CONFIRMAR_REINGRESO_RAPIDO',
        tipo_sugerido: 'ENTRADA',
        participante: { dni: participante.dni, nombres: participante.nombres },
        ultima_hora: formatearHoraCorta(ultimaCerradaHoy.hora_salida),
        mensaje: `Acabas de registrar tu SALIDA hace unos segundos (${formatearHoraCorta(
          ultimaCerradaHoy.hora_salida
        )}). ¿Deseas abrir una nueva ENTRADA ahora mismo?`,
      };
    }

    const nuevoBloque = {
      id: store.nextId++,
      dni,
      fecha,
      hora_entrada: hora,
      hora_salida: null,
      minutos: 0,
      ts_entrada: ts,
      ts_salida: null,
      nota: nota || '',
    };
    store.sesiones.push(nuevoBloque);
    saveStoreToDisk();

    const estado = obtenerEstadoParticipante(dni, fecha);
    return {
      ok: true,
      tipo: 'ENTRADA',
      mensaje: '¡Entrada registrada correctamente!',
      fecha,
      hora_marca: formatearHoraCorta(hora),
      hora_completa: hora,
      bloque_id: nuevoBloque.id,
      numero_bloque_hoy: estado.bloques_hoy.length,
      ...estado,
    };
  } else {
    if (
      !forzar &&
      !fechaCustom &&
      !horaCustom &&
      Math.abs(ts - sesionAbiertaHoy.ts_entrada) < 45000
    ) {
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
    sesionAbiertaHoy.hora_salida = hora;
    sesionAbiertaHoy.ts_salida = ts;
    sesionAbiertaHoy.minutos = minutosBloque;
    if (nota) sesionAbiertaHoy.nota = nota;
    saveStoreToDisk();

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

function registrarBloqueManual({
  dni: rawDni,
  nombres,
  fecha,
  hora_entrada,
  hora_salida,
  nota = '',
}) {
  const dni = cleanDNI(rawDni);
  if (!dni || !fecha || !hora_entrada) {
    throw new Error('DNI, fecha y hora de entrada son obligatorios');
  }

  if (!store.participantes[dni]) {
    const nom = String(nombres || `Participante ${dni}`).trim();
    store.participantes[dni] = {
      dni,
      nombres: nom,
      nombres_norm: normalizarTexto(nom),
      datos_extra: {},
      origen: 'MANUAL',
      creado_en: new Date().toISOString(),
    };
  }

  const entradaNorm = hora_entrada.length === 5 ? `${hora_entrada}:00` : hora_entrada;
  const tsEntrada = getNowLocal(fecha, entradaNorm).ts;

  if (hora_salida) {
    const salidaNorm = hora_salida.length === 5 ? `${hora_salida}:00` : hora_salida;
    const tsSalida = getNowLocal(fecha, salidaNorm).ts;
    const minutos = calcularMinutosBloque(entradaNorm, salidaNorm);
    store.sesiones.push({
      id: store.nextId++,
      dni,
      fecha,
      hora_entrada: entradaNorm,
      hora_salida: salidaNorm,
      minutos,
      ts_entrada: tsEntrada,
      ts_salida: tsSalida,
      nota: nota || 'Registro manual',
    });
  } else {
    store.sesiones.push({
      id: store.nextId++,
      dni,
      fecha,
      hora_entrada: entradaNorm,
      hora_salida: null,
      minutos: 0,
      ts_entrada: tsEntrada,
      ts_salida: null,
      nota: nota || 'Entrada manual',
    });
  }

  saveStoreToDisk();
  return obtenerEstadoParticipante(dni, fecha);
}

function actualizarBloque(id, { fecha, hora_entrada, hora_salida, nota }) {
  const sesion = store.sesiones.find((s) => s.id === Number(id));
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

  sesion.fecha = nuevaFecha;
  sesion.hora_entrada = nuevaEntrada;
  sesion.hora_salida = nuevaSalida;
  sesion.minutos = minutos;
  sesion.ts_entrada = tsEntrada;
  sesion.ts_salida = tsSalida;
  if (nota !== undefined) sesion.nota = nota;
  saveStoreToDisk();
  return true;
}

function eliminarBloque(id) {
  store.sesiones = store.sesiones.filter((s) => s.id !== Number(id));
  saveStoreToDisk();
  return true;
}

function cerrarSesionesAbiertas({ fecha, hora_cierre }) {
  const horaNorm =
    hora_cierre && hora_cierre.length === 5
      ? `${hora_cierre}:00`
      : hora_cierre || getNowLocal().hora;

  let cerradas = 0;
  for (const s of store.sesiones) {
    if (!s.hora_salida && (!fecha || s.fecha === fecha)) {
      const minutos = calcularMinutosBloque(s.hora_entrada, horaNorm);
      const tsOut = getNowLocal(s.fecha, horaNorm).ts;
      s.hora_salida = horaNorm;
      s.ts_salida = tsOut;
      s.minutos = minutos;
      s.nota = s.nota
        ? `${s.nota} | Cierre grupal (${formatearHoraCorta(horaNorm)})`
        : `Cierre grupal (${formatearHoraCorta(horaNorm)})`;
      cerradas++;
    }
  }
  saveStoreToDisk();
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
  } catch (_) { }

  const fechasSet = new Set();
  for (const s of store.sesiones) fechasSet.add(s.fecha);
  const fechasOrdenadas = Array.from(fechasSet).sort();

  const porDni = new Map();
  const participantesOrdenados = Object.values(store.participantes).sort((a, b) =>
    a.nombres.localeCompare(b.nombres)
  );

  for (const p of participantesOrdenados) {
    porDni.set(p.dni, {
      dni: p.dni,
      nombres: p.nombres,
      datos_extra: p.datos_extra || {},
      origen: p.origen || 'FORMS',
      dentro: false,
      sesion_abierta: null,
      minutos_total: 0,
      minutos_hoy: 0,
      por_fecha: {},
      bloques: [],
    });
  }

  const dentroAhora = [];
  const sesionesOrdenadas = [...store.sesiones].sort((a, b) =>
    `${a.fecha}_${a.hora_entrada}`.localeCompare(`${b.fecha}_${b.hora_entrada}`)
  );

  for (const s of sesionesOrdenadas) {
    if (!porDni.has(s.dni)) {
      porDni.set(s.dni, {
        dni: s.dni,
        nombres: `DNI ${s.dni}`,
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

  const ultimosMovimientos = [...store.sesiones]
    .sort((a, b) => (b.ts_salida || b.ts_entrada) - (a.ts_salida || a.ts_entrada))
    .slice(0, 25)
    .map((s) => ({
      id: s.id,
      dni: s.dni,
      nombres: store.participantes[s.dni]?.nombres || `DNI ${s.dni}`,
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
      total_bloques: store.sesiones.length,
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
  const demoDnis = new Set(demoParticipantes.map((p) => p.dni));
  store.sesiones = store.sesiones.filter((s) => !demoDnis.has(s.dni));

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

function limpiarTodo({ incluirParticipantes = true } = {}) {
  store.sesiones = [];
  if (incluirParticipantes) {
    store.participantes = {};
    store.config.columnas_forms = '[]';
  }
  saveStoreToDisk();
  return obtenerResumenGeneral();
}

// Al iniciar cualquier instancia, asegurar que todos los participantes y sesiones rescatadas estén cargados
try {
  const semillaPath = path.join(__dirname, 'participantes_semilla.json');
  if (fs.existsSync(semillaPath)) {
    const semilla = JSON.parse(fs.readFileSync(semillaPath, 'utf8'));
    importarParticipantes(semilla, 'FORMS');
  }
  const sesionesSemillaPath = path.join(__dirname, 'sesiones_semilla.json');
  if (fs.existsSync(sesionesSemillaPath) && store.sesiones.length === 0) {
    const sesSemilla = JSON.parse(fs.readFileSync(sesionesSemillaPath, 'utf8'));
    for (const s of sesSemilla) {
      const tsEntrada = getNowLocal(s.fecha, s.hora_entrada).ts;
      store.sesiones.push({
        id: store.nextId++,
        dni: s.dni,
        fecha: s.fecha,
        hora_entrada: s.hora_entrada,
        hora_salida: s.hora_salida || null,
        minutos: Number(s.minutos || 0),
        ts_entrada: tsEntrada,
        ts_salida: null,
        nota: s.nota || '',
      });
    }
    saveStoreToDisk();
  }
} catch (_) {}

function sincronizarEstadoCliente({ participantes = [], sesiones = [] } = {}) {
  let cambio = false;
  for (const p of participantes) {
    if (!p || !p.dni || !p.nombres) continue;
    const dni = cleanDNI(p.dni);
    if (!store.participantes[dni]) {
      store.participantes[dni] = {
        dni,
        nombres: p.nombres,
        nombres_norm: normalizarTexto(p.nombres),
        datos_extra: p.datos_extra || {},
        origen: p.origen || 'PUERTA',
        creado_en: new Date().toISOString(),
      };
      cambio = true;
    } else if (p.datos_extra && Object.keys(p.datos_extra).length > 0) {
      store.participantes[dni].datos_extra = {
        ...p.datos_extra,
        ...(store.participantes[dni].datos_extra || {}),
      };
    }
  }

  for (const s of sesiones) {
    if (!s || !s.dni || !s.fecha || !s.hora_entrada) continue;
    const dni = cleanDNI(s.dni);
    const hIn = s.hora_entrada.length === 5 ? `${s.hora_entrada}:00` : s.hora_entrada;
    const hOut = s.hora_salida
      ? s.hora_salida.length === 5
        ? `${s.hora_salida}:00`
        : s.hora_salida
      : null;

    const existente = store.sesiones.find(
      (x) => x.dni === dni && x.fecha === s.fecha && x.hora_entrada.slice(0, 5) === hIn.slice(0, 5)
    );
    if (!existente) {
      const tsEntrada = getNowLocal(s.fecha, hIn).ts;
      const tsSalida = hOut ? getNowLocal(s.fecha, hOut).ts : null;
      const minutos = hOut ? calcularMinutosBloque(hIn, hOut) : 0;
      store.sesiones.push({
        id: store.nextId++,
        dni,
        fecha: s.fecha,
        hora_entrada: hIn,
        hora_salida: hOut,
        minutos,
        ts_entrada: tsEntrada,
        ts_salida: tsSalida,
        nota: s.nota || '',
      });
      cambio = true;
    } else if (!existente.hora_salida && hOut) {
      existente.hora_salida = hOut;
      existente.ts_salida = getNowLocal(s.fecha, hOut).ts;
      existente.minutos = calcularMinutosBloque(existente.hora_entrada, hOut);
      cambio = true;
    }
  }

  if (cambio) saveStoreToDisk();
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
  sincronizarEstadoCliente,
  cargarDatosEjemplo,
  limpiarTodo,
  formatearMinutos,
};
