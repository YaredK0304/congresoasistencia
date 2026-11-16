(() => {
  const kpiInscritos = document.getElementById('kpi-inscritos');
  const kpiDentro = document.getElementById('kpi-dentro');
  const kpiConRegistro = document.getElementById('kpi-con-registro');
  const kpiBloques = document.getElementById('kpi-bloques');

  const adminTitle = document.getElementById('admin-event-title');
  const adminNetInfo = document.getElementById('admin-network-info');
  const adminToast = document.getElementById('admin-toast');

  const filtroBuscar = document.getElementById('filtro-buscar');
  const filtroEstado = document.getElementById('filtro-estado');
  const theadResumen = document.getElementById('thead-resumen');
  const tbodyResumen = document.getElementById('tbody-resumen');

  const modalBloques = document.getElementById('modal-bloques');
  const modalPartNombre = document.getElementById('modal-part-nombre');
  const modalPartDni = document.getElementById('modal-part-dni');
  const modalListaBloques = document.getElementById('modal-lista-bloques');
  const btnCerrarModal = document.getElementById('btn-cerrar-modal');
  const addBloqueFecha = document.getElementById('add-bloque-fecha');
  const addBloqueEntrada = document.getElementById('add-bloque-entrada');
  const addBloqueSalida = document.getElementById('add-bloque-salida');
  const btnGuardarBloqueManual = document.getElementById('btn-guardar-bloque-manual');

  let estadoGlobal = null;
  let modalDniActual = null;

  function showToast(msg, isError = false) {
    adminToast.textContent = msg;
    adminToast.style.background = isError ? '#fef2f2' : '#ecfdf5';
    adminToast.style.borderColor = isError ? '#fecaca' : '#6ee7b7';
    adminToast.style.color = isError ? '#b91c1c' : '#065f46';
    adminToast.classList.remove('hidden');
    setTimeout(() => {
      adminToast.classList.add('hidden');
    }, 5500);
  }

  // Navegación por pestañas
  function activarTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('hidden', p.id !== tabId);
    });
  }

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activarTab(btn.getAttribute('data-tab'));
    });
  });

  if (window.location.hash === '#qr') {
    activarTab('tab-qr');
  }

  document.getElementById('btn-export-xlsx-top').addEventListener('click', () => {
    window.location.href = '/api/admin/exportar.xlsx';
  });

  const btnLogout = document.getElementById('btn-logout');
  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      await fetch('/api/logout', { method: 'POST' });
      window.location.href = '/login';
    });
  }

  const btnGuardarCredenciales = document.getElementById('btn-guardar-credenciales');
  if (btnGuardarCredenciales) {
    btnGuardarCredenciales.addEventListener('click', async () => {
      const usuario = document.getElementById('cfg-admin-user').value.trim();
      const password = document.getElementById('cfg-admin-pass').value;
      if (!password || password.length < 4) {
        showToast('Ingresa una contraseña nueva de al menos 4 caracteres.', true);
        return;
      }
      const resp = await fetch('/api/admin/credenciales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuario, password }),
      });
      const data = await resp.json();
      if (data.ok) {
        document.getElementById('cfg-admin-pass').value = '';
        showToast(data.mensaje);
      }
    });
  }

  function formatearEtiquetaFecha(fechaIso) {
    // 2026-11-16 -> Lun 16/11
    const partes = String(fechaIso).split('-').map(Number);
    if (partes.length !== 3) return fechaIso;
    const d = new Date(partes[0], partes[1] - 1, partes[2]);
    const dias = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    return `${dias[d.getDay()]} ${String(partes[2]).padStart(2, '0')}/${String(partes[1]).padStart(
      2,
      '0'
    )}`;
  }

  function renderTablaResumen() {
    if (!estadoGlobal) return;
    const fechas = estadoGlobal.fechas || [];
    const query = (filtroBuscar.value || '').toLowerCase().trim();
    const filtro = filtroEstado.value;

    // Construir cabeceras dinámicas por cada día del congreso
    theadResumen.innerHTML = `
      <tr>
        <th>DNI</th>
        <th>Nombres y Apellidos</th>
        <th>Estado en Auditorio</th>
        ${fechas
          .map(
            (f) =>
              `<th>📅 ${formatearEtiquetaFecha(f)}<div style="font-size:0.72rem; font-weight:500; color:#64748b;">${f}</div></th>`
          )
          .join('')}
        <th>⏱️ Total Acumulado</th>
        <th>Acciones</th>
      </tr>
    `;

    const filtrados = (estadoGlobal.participantes || []).filter((p) => {
      if (
        query &&
        !p.dni.toLowerCase().includes(query) &&
        !p.nombres.toLowerCase().includes(query)
      ) {
        return false;
      }
      if (filtro === 'DENTRO' && !p.dentro) return false;
      if (filtro === 'CON_HORAS' && p.minutos_total <= 0 && !p.dentro) return false;
      if (filtro === 'SIN_HORAS' && (p.minutos_total > 0 || p.dentro)) return false;
      return true;
    });

    if (filtrados.length === 0) {
      tbodyResumen.innerHTML = `
        <tr>
          <td colspan="${4 + fechas.length}" style="text-align:center; padding:28px; color:#64748b;">
            No hay participantes que coincidan con el filtro actual. Puedes importar tu lista desde la pestaña "Base de Datos Google Forms" o hacer clic en "Cargar Ejemplo".
          </td>
        </tr>
      `;
      return;
    }

    tbodyResumen.innerHTML = filtrados
      .map((p) => {
        const celdasFechas = fechas
          .map((f) => {
            const infoF = p.por_fecha[f];
            if (!infoF || infoF.bloques.length === 0) {
              return `<td style="color:#94a3b8;">0h 00m</td>`;
            }
            const badgesBloques = infoF.bloques
              .map(
                (b) =>
                  `<div style="font-size:0.76rem; color:${
                    b.en_curso ? '#059669' : '#475569'
                  }; white-space:nowrap;">• ${b.hora_entrada} → ${
                    b.hora_salida || 'En sala'
                  } <strong>(${b.duracion_texto})</strong></div>`
              )
              .join('');

            return `
              <td>
                <div style="font-weight:800; color:#0f172a; margin-bottom:2px;">${infoF.horas_texto}</div>
                ${badgesBloques}
              </td>
            `;
          })
          .join('');

        const extraBadges = Object.entries(p.datos_extra || {})
          .map(
            ([k, v]) =>
              `<span style="display:inline-block; background:#f1f5f9; border:1px solid #cbd5e1; border-radius:6px; padding:1px 6px; font-size:0.72rem; color:#334155; margin-right:4px; margin-top:2px;"><strong>${k}:</strong> ${v}</span>`
          )
          .join('');

        return `
          <tr>
            <td style="font-weight:800; font-family:monospace; font-size:0.94rem;">${p.dni}</td>
            <td>
              <div style="font-weight:700; color:#0f172a;">${p.nombres}</div>
              <div style="font-size:0.74rem; color:#64748b;">Origen: ${p.origen}</div>
              ${extraBadges ? `<div style="margin-top:2px;">${extraBadges}</div>` : ''}
            </td>
            <td>
              ${
                p.dentro
                  ? `<span class="status-pill pill-in">🟢 En sala (desde ${p.sesion_abierta?.hora_entrada})</span>`
                  : `<span class="status-pill pill-out">⚪ Fuera</span>`
              }
            </td>
            ${celdasFechas}
            <td>
              <div style="font-size:1.05rem; font-weight:900; color:#1d4ed8;">${p.horas_total_texto}</div>
              <div style="font-size:0.75rem; color:#64748b;">${p.horas_total_decimal} hrs (${p.minutos_total} min)</div>
            </td>
            <td>
              <div style="display:flex; gap:6px; flex-wrap:wrap;">
                <button type="button" class="btn btn-secondary btn-sm btn-ver-bloques" data-dni="${p.dni}">
                  ✏️ Bloques (${p.total_bloques})
                </button>
                <button type="button" class="btn ${
                  p.dentro ? 'btn-salida' : 'btn-entrada'
                } btn-sm btn-marca-rapida" data-dni="${p.dni}" style="padding:6px 10px; font-size:0.78rem;">
                  ${p.dentro ? '👋 Marcar Salida' : '✅ Marcar Entrada'}
                </button>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');

    tbodyResumen.querySelectorAll('.btn-ver-bloques').forEach((btn) => {
      btn.addEventListener('click', () => {
        abrirModalParticipante(btn.getAttribute('data-dni'));
      });
    });

    tbodyResumen.querySelectorAll('.btn-marca-rapida').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const dni = btn.getAttribute('data-dni');
        await marcarDirectoPuerta({ dni, forzar: true });
      });
    });
  }

  function renderPanelPuerta() {
    if (!estadoGlobal) return;
    const dentro = estadoGlobal.dentro_ahora || [];
    const movs = estadoGlobal.ultimos_movimientos || [];

    document.getElementById('count-dentro-panel').textContent = dentro.length;
    const contDentro = document.getElementById('lista-dentro-ahora');

    if (dentro.length === 0) {
      contDentro.innerHTML = `<div style="padding:14px; background:#f8fafc; border-radius:10px; color:#64748b; font-size:0.86rem;">No hay nadie con entrada abierta en este instante.</div>`;
    } else {
      contDentro.innerHTML = dentro
        .map(
          (d) => `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px; border:1px solid #d1fae5; background:#ecfdf5; border-radius:10px; margin-bottom:8px;">
            <div>
              <div style="font-weight:800; font-size:0.9rem; color:#065f46;">${d.nombres}</div>
              <div style="font-size:0.78rem; color:#047857;">DNI: ${d.dni} • Entró a las <strong>${d.hora_entrada}</strong> (${d.fecha})</div>
            </div>
            <button type="button" class="btn btn-salida btn-sm btn-salir-directo" data-dni="${d.dni}" style="padding:6px 12px; font-size:0.78rem;">
              👋 Registrar Salida
            </button>
          </div>
        `
        )
        .join('');

      contDentro.querySelectorAll('.btn-salir-directo').forEach((btn) => {
        btn.addEventListener('click', () => {
          marcarDirectoPuerta({ dni: btn.getAttribute('data-dni'), forzar: true });
        });
      });
    }

    const contMovs = document.getElementById('lista-ultimos-movimientos');
    if (movs.length === 0) {
      contMovs.innerHTML = `<div style="padding:14px; color:#64748b; font-size:0.85rem;">Sin movimientos aún.</div>`;
    } else {
      contMovs.innerHTML = movs
        .map(
          (m) => `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border-bottom:1px solid #f1f5f9; font-size:0.83rem;">
            <div>
              <strong>${m.nombres}</strong> <span style="color:#64748b;">(${m.dni})</span>
              <div style="font-size:0.75rem; color:#64748b;">${m.fecha} • Bloque: ${m.hora_entrada} ${
            m.hora_salida ? `→ ${m.hora_salida}` : '(En sala)'
          }</div>
            </div>
            <span class="status-pill ${m.tipo === 'ENTRADA' ? 'pill-in' : 'pill-out'}">
              ${m.tipo === 'ENTRADA' ? `🟢 ENTRADA ${m.hora_entrada}` : `👋 SALIDA ${m.hora_salida} (+${m.duracion_texto})`}
            </span>
          </div>
        `
        )
        .join('');
    }
  }

  async function cargarResumen() {
    try {
      const resp = await fetch('/api/admin/resumen');
      if (resp.status === 401) {
        window.location.href = '/login';
        return;
      }
      const data = await resp.json();
      if (!data.ok) return;

      estadoGlobal = data;
      kpiInscritos.textContent = data.metricas.total_inscritos;
      kpiDentro.textContent = data.metricas.dentro_ahora;
      kpiConRegistro.textContent = data.metricas.asistentes_con_registro;
      kpiBloques.textContent = data.metricas.total_bloques;

      if (data.config?.nombre_evento) {
        adminTitle.textContent = data.config.nombre_evento;
        document.getElementById('poster-title').textContent = data.config.nombre_evento;
        document.getElementById('cfg-nombre-evento').value = data.config.nombre_evento;
      }
      if (data.config?.admin_user && !document.getElementById('cfg-admin-user').value) {
        document.getElementById('cfg-admin-user').value = data.config.admin_user;
      }
      if (data.config?.sheets_url) {
        document.getElementById('input-sheets-url').value = data.config.sheets_url;
      }

      if (!addBloqueFecha.value) {
        addBloqueFecha.value = data.hoy;
      }
      if (!document.getElementById('sim-fecha').value) {
        document.getElementById('sim-fecha').value = data.hoy;
      }

      renderTablaResumen();
      renderPanelPuerta();

      if (modalDniActual && !modalBloques.classList.contains('hidden')) {
        renderContenidoModal(modalDniActual);
      }
    } catch (e) {
      console.error('Error cargando resumen:', e);
    }
  }

  async function cargarInfoQR(customUrl) {
    try {
      const q = customUrl ? `?url=${encodeURIComponent(customUrl)}` : '';
      const resp = await fetch(`/api/info${q}`);
      const data = await resp.json();
      if (!data.ok) return;

      const urlFinal = customUrl || data.red.url_formulario_qr;
      adminNetInfo.textContent = `Enlace QR para celulares: ${urlFinal}`;
      if (!document.getElementById('cfg-url-qr').value) {
        document.getElementById('cfg-url-qr').value = urlFinal;
      }
      document.getElementById('poster-url-text').textContent = urlFinal;
      document.getElementById('poster-qr-container').innerHTML = data.qr_svg;
    } catch (_) {}
  }

  filtroBuscar.addEventListener('input', renderTablaResumen);
  filtroEstado.addEventListener('change', renderTablaResumen);

  // ==========================================
  // MODAL DE EDICIÓN DE BLOQUES POR PARTICIPANTE
  // ==========================================

  function renderContenidoModal(dni) {
    const p = (estadoGlobal?.participantes || []).find((x) => x.dni === dni);
    if (!p) return;
    modalPartNombre.textContent = `${p.nombres} (Total: ${p.horas_total_texto})`;
    modalPartDni.textContent = `DNI: ${p.dni}`;

    if (!p.bloques || p.bloques.length === 0) {
      modalListaBloques.innerHTML = `<div style="padding:14px; background:#f8fafc; border-radius:10px; color:#64748b; font-size:0.86rem;">Este participante aún no tiene bloques de entrada/salida registrados.</div>`;
      return;
    }

    modalListaBloques.innerHTML = `
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Entrada</th>
              <th>Salida</th>
              <th>Duración</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${p.bloques
              .map(
                (b) => `
                <tr>
                  <td><input type="date" class="input-sm edit-fecha" data-id="${b.id}" value="${b.fecha}" style="padding:5px 8px;" /></td>
                  <td><input type="time" class="input-sm edit-entrada" data-id="${b.id}" value="${b.hora_entrada}" style="padding:5px 8px;" /></td>
                  <td><input type="time" class="input-sm edit-salida" data-id="${b.id}" value="${b.hora_salida || ''}" style="padding:5px 8px;" /></td>
                  <td style="font-weight:800;">${b.duracion_texto}</td>
                  <td>
                    <div style="display:flex; gap:6px;">
                      <button type="button" class="btn btn-primary btn-sm btn-save-bloque" data-id="${b.id}" style="padding:5px 10px;">💾</button>
                      <button type="button" class="btn btn-danger btn-sm btn-del-bloque" data-id="${b.id}" style="padding:5px 10px;">🗑️</button>
                    </div>
                  </td>
                </tr>
              `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;

    modalListaBloques.querySelectorAll('.btn-save-bloque').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const f = modalListaBloques.querySelector(`.edit-fecha[data-id="${id}"]`).value;
        const hIn = modalListaBloques.querySelector(`.edit-entrada[data-id="${id}"]`).value;
        const hOut = modalListaBloques.querySelector(`.edit-salida[data-id="${id}"]`).value;
        await fetch(`/api/admin/bloque/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fecha: f, hora_entrada: hIn, hora_salida: hOut }),
        });
        showToast('Bloque actualizado y horas recalculadas.');
        await cargarResumen();
      });
    });

    modalListaBloques.querySelectorAll('.btn-del-bloque').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        await fetch(`/api/admin/bloque/${id}`, { method: 'DELETE' });
        showToast('Bloque eliminado.');
        await cargarResumen();
      });
    });
  }

  function abrirModalParticipante(dni) {
    modalDniActual = dni;
    renderContenidoModal(dni);
    modalBloques.classList.remove('hidden');
  }

  btnCerrarModal.addEventListener('click', () => {
    modalBloques.classList.add('hidden');
    modalDniActual = null;
  });

  btnGuardarBloqueManual.addEventListener('click', async () => {
    if (!modalDniActual) return;
    await fetch('/api/admin/bloque', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dni: modalDniActual,
        fecha: addBloqueFecha.value,
        hora_entrada: addBloqueEntrada.value,
        hora_salida: addBloqueSalida.value,
      }),
    });
    showToast('Bloque manual agregado correctamente.');
    await cargarResumen();
  });

  // ==========================================
  // REGISTRO EN PUERTA / SIMULADOR
  // ==========================================

  async function marcarDirectoPuerta({ dni, nombres, fecha, hora, forzar = true }) {
    const resp = await fetch('/api/marcar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dni, nombres, fecha, hora, forzar }),
    });
    const data = await resp.json();
    if (!data.ok) {
      showToast(data.mensaje || 'Error al registrar marca', true);
      return;
    }
    const msg =
      data.tipo === 'ENTRADA'
        ? `✅ ENTRADA registrada: ${data.participante.nombres} (${data.hora_marca})`
        : `👋 SALIDA registrada: ${data.participante.nombres} (${data.hora_entrada_bloque} → ${data.hora_marca} | +${data.horas_bloque_texto} | Total: ${data.horas_total_texto})`;
    showToast(msg);
    await cargarResumen();
  }

  document.getElementById('btn-sim-marcar').addEventListener('click', async () => {
    const dni = document.getElementById('sim-dni').value.trim();
    const nombres = document.getElementById('sim-nombres').value.trim();
    const fecha = document.getElementById('sim-fecha').value || undefined;
    const hora = document.getElementById('sim-hora').value || undefined;
    if (!dni && !nombres) {
      showToast('Ingresa el DNI o el nombre del participante.', true);
      return;
    }
    await marcarDirectoPuerta({ dni, nombres, fecha, hora, forzar: true });
  });

  document.getElementById('btn-cerrar-abiertas').addEventListener('click', async () => {
    const horaCierre = document.getElementById('cierre-hora').value || '11:00';
    const resp = await fetch('/api/admin/cerrar-abiertas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hora_cierre: horaCierre }),
    });
    const data = await resp.json();
    if (data.ok) {
      showToast(data.mensaje);
      await cargarResumen();
    }
  });

  // ==========================================
  // IMPORTAR BASE DE DATOS DE GOOGLE FORMS
  // ==========================================

  document.getElementById('btn-subir-archivo').addEventListener('click', () => {
    const fileInput = document.getElementById('file-forms');
    const file = fileInput.files[0];
    if (!file) {
      showToast('Selecciona primero un archivo .xlsx o .csv de tu computadora.', true);
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = String(reader.result).split(',')[1];
      const resp = await fetch('/api/admin/importar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre_archivo: file.name,
          archivo_base64: base64,
        }),
      });
      const data = await resp.json();
      if (!data.ok) {
        showToast(data.mensaje, true);
        return;
      }
      showToast(data.mensaje);
      await cargarResumen();
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('btn-sync-sheets').addEventListener('click', async () => {
    const url = document.getElementById('input-sheets-url').value.trim();
    if (!url) {
      showToast('Pega primero el enlace de tu Google Sheets.', true);
      return;
    }
    if (url.includes('/forms/') || url.includes('/viewform') || url.includes('forms.gle')) {
      showToast(
        '⚠️ Ese es el link de la encuesta (/viewform). Ve a tu pestaña del Forms → "Respuestas" → botón verde "Ver en Hojas de cálculo", pon esa hoja en "Cualquier persona con el enlace" y pega aquí el link de Google Sheets.',
        true
      );
      return;
    }
    const resp = await fetch('/api/admin/sincronizar-sheets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await resp.json();
    if (!data.ok) {
      showToast(data.mensaje, true);
      return;
    }
    showToast(data.mensaje);
    await cargarResumen();
  });

  document.getElementById('btn-importar-texto').addEventListener('click', async () => {
    const texto = document.getElementById('textarea-pegar-forms').value.trim();
    if (!texto) {
      showToast('Pega las filas con DNI y Nombres primero.', true);
      return;
    }
    const resp = await fetch('/api/admin/importar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto }),
    });
    const data = await resp.json();
    if (!data.ok) {
      showToast(data.mensaje, true);
      return;
    }
    showToast(data.mensaje);
    document.getElementById('textarea-pegar-forms').value = '';
    await cargarResumen();
  });

  document.getElementById('btn-cargar-demo').addEventListener('click', async () => {
    const resp = await fetch('/api/admin/demo', { method: 'POST' });
    const data = await resp.json();
    if (data.ok) {
      showToast(data.mensaje);
      await cargarResumen();
    }
  });

  document.getElementById('btn-limpiar-bd').addEventListener('click', async () => {
    if (!confirm('¿Deseas limpiar todos los bloques de asistencia registrados?')) return;
    await fetch('/api/admin/limpiar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ incluirParticipantes: false }),
    });
    showToast('Se reiniciaron los registros de asistencia.');
    await cargarResumen();
  });

  // ==========================================
  // CONFIGURACIÓN DE QR Y CARTEL IMPRIMIBLE
  // ==========================================

  document.getElementById('btn-guardar-cfg').addEventListener('click', async () => {
    const nombreEvento = document.getElementById('cfg-nombre-evento').value.trim();
    const urlQr = document.getElementById('cfg-url-qr').value.trim();
    if (nombreEvento) {
      await fetch('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre_evento: nombreEvento }),
      });
    }
    await cargarInfoQR(urlQr);
    await cargarResumen();
    showToast('Cartel QR y título actualizados.');
  });

  document.getElementById('btn-imprimir-qr').addEventListener('click', () => {
    window.print();
  });

  // Carga inicial y refresco automático cada 4 segundos para el monitor en vivo
  cargarResumen();
  cargarInfoQR();
  setInterval(cargarResumen, 4000);
})();
