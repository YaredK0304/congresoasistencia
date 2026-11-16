(() => {
  const uiTitle = document.getElementById('ui-event-title');
  const uiClock = document.getElementById('ui-live-clock');

  const viewForm = document.getElementById('view-form');
  const viewPass = document.getElementById('view-pass');

  const inputBusqueda = document.getElementById('input-busqueda');
  const autocompleteBox = document.getElementById('autocomplete-box');
  const btnLimpiarInput = document.getElementById('btn-limpiar-input');

  const nuevoBox = document.getElementById('nuevo-participante-box');
  const inputNombresNuevo = document.getElementById('input-nombres-nuevo');

  const previewBox = document.getElementById('preview-box');
  const prevName = document.getElementById('prev-name');
  const prevDni = document.getElementById('prev-dni');
  const prevBadge = document.getElementById('prev-badge');
  const prevStatusDetail = document.getElementById('prev-status-detail');
  const prevHoy = document.getElementById('prev-hoy');
  const prevTotal = document.getElementById('prev-total');
  const prevBloquesContainer = document.getElementById('prev-bloques-container');
  const prevBloquesList = document.getElementById('prev-bloques-list');

  const confirmRapidoBox = document.getElementById('confirm-rapido-box');
  const confirmRapidoMsg = document.getElementById('confirm-rapido-msg');
  const btnForzarMarca = document.getElementById('btn-forzar-marca');
  const btnCancelarForzar = document.getElementById('btn-cancelar-forzar');

  const errorBox = document.getElementById('error-box');
  const btnSubmitMarca = document.getElementById('btn-submit-marca');
  const btnVolverInicio = document.getElementById('btn-volver-inicio');

  let selectedDni = '';
  let selectedParticipantState = null;
  let searchTimeout = null;
  let currentSearchController = null;

  // Reloj en vivo
  function updateClock() {
    const now = new Date();
    const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    const diaSemana = dias[now.getDay()];
    const fechaStr = `${diaSemana} ${now.getDate()} ${meses[now.getMonth()]}`;
    const horaStr = now.toLocaleTimeString('es-PE', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    uiClock.textContent = `🕒 ${fechaStr} • ${horaStr}`;
  }
  setInterval(updateClock, 1000);
  updateClock();

  // Cargar título del evento y Código QR en la página principal
  const homeQrPanel = document.getElementById('home-qr-panel');
  const homeQrSvg = document.getElementById('home-qr-svg');
  const homeQrUrl = document.getElementById('home-qr-url');
  const btnToggleQrHome = document.getElementById('btn-toggle-qr-home');

  if (btnToggleQrHome && homeQrPanel) {
    btnToggleQrHome.addEventListener('click', () => {
      homeQrPanel.classList.toggle('hidden');
    });
  }

  fetch('/api/info')
    .then((r) => r.json())
    .then((data) => {
      if (data.ok) {
        if (data.config?.nombre_evento) {
          uiTitle.textContent = data.config.nombre_evento;
        }
        if (homeQrSvg && data.qr_svg) {
          homeQrSvg.innerHTML = data.qr_svg;
        }
        if (homeQrUrl && data.red?.url_formulario_qr) {
          homeQrUrl.textContent = data.red.url_formulario_qr;
        }
      }
    })
    .catch(() => {});

  function showError(msg) {
    if (!msg) {
      errorBox.classList.add('hidden');
      errorBox.textContent = '';
      return;
    }
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
  }

  const inputCorreoNuevo = document.getElementById('input-correo-nuevo');

  function resetPreview() {
    selectedParticipantState = null;
    previewBox.classList.add('hidden');
    nuevoBox.classList.remove('hidden');
    inputNombresNuevo.classList.remove('hidden');
    confirmRapidoBox.classList.add('hidden');
    showError('');
    btnSubmitMarca.className = 'btn btn-entrada btn-block';
    btnSubmitMarca.textContent = '✅ REGISTRAR ASISTENCIA';
  }

  function renderParticipantPreview(estado) {
    selectedParticipantState = estado;
    selectedDni = estado.participante.dni;
    nuevoBox.classList.remove('hidden');
    inputNombresNuevo.classList.add('hidden');
    if (inputCorreoNuevo && estado.participante.correo && !inputCorreoNuevo.value) {
      inputCorreoNuevo.value = estado.participante.correo;
    }
    confirmRapidoBox.classList.add('hidden');
    showError('');

    prevName.textContent = estado.participante.nombres;
    prevDni.textContent = `DNI: ${estado.participante.dni}`;
    prevHoy.textContent = estado.horas_hoy_texto;
    prevTotal.textContent = estado.horas_total_texto;

    if (estado.dentro && estado.sesion_abierta) {
      previewBox.className = 'participant-preview is-inside';
      prevBadge.className = 'status-pill pill-in';
      prevBadge.textContent = '🟢 En Auditorio';
      const horaIn = String(estado.sesion_abierta.hora_entrada).slice(0, 5);
      prevStatusDetail.innerHTML = `Tienes una <strong>ENTRADA activa desde las ${horaIn}</strong>. Al confirmar se registrará tu <strong>SALIDA</strong> y se sumarán tus horas de este bloque.`;
      btnSubmitMarca.className = 'btn btn-salida btn-block';
      btnSubmitMarca.textContent = `👋 REGISTRAR SALIDA AHORA (Entró ${horaIn})`;
    } else {
      previewBox.className = 'participant-preview is-outside';
      prevBadge.className = 'status-pill pill-out';
      prevBadge.textContent = '⚪ Fuera de sala';
      prevStatusDetail.innerHTML = `Listo para iniciar un nuevo bloque. Al confirmar se registrará tu <strong>ENTRADA</strong> al auditorio.`;
      btnSubmitMarca.className = 'btn btn-entrada btn-block';
      btnSubmitMarca.textContent = '✅ REGISTRAR ENTRADA AHORA';
    }

    if (estado.bloques_hoy && estado.bloques_hoy.length > 0) {
      prevBloquesContainer.classList.remove('hidden');
      prevBloquesList.innerHTML = estado.bloques_hoy
        .map(
          (b, idx) =>
            `<div style="display:flex; justify-content:space-between; padding:3px 0;">
              <span>Bloque ${idx + 1}: <strong>${b.hora_entrada_corta}</strong> → <strong>${
              b.hora_salida_corta || 'En sala'
            }</strong></span>
              <span style="font-weight:700;">${b.duracion_texto}</span>
            </div>`
        )
        .join('');
    } else {
      prevBloquesContainer.classList.add('hidden');
    }

    previewBox.classList.remove('hidden');
  }

  async function consultarDniExacto(dni) {
    try {
      const resp = await fetch(`/api/participante?dni=${encodeURIComponent(dni)}`);
      const data = await resp.json();
      if (data.ok && data.encontrado && data.estado) {
        renderParticipantPreview(data.estado);
        return true;
      }
    } catch (_) {}
    return false;
  }

  function renderAutocomplete(resultados) {
    if (!resultados || resultados.length === 0) {
      autocompleteBox.classList.add('hidden');
      autocompleteBox.innerHTML = '';
      return;
    }

    autocompleteBox.innerHTML = resultados
      .map(
        (r) => `
        <div class="autocomplete-item" data-dni="${r.dni}" data-nombres="${r.nombres.replace(/"/g, '&quot;')}">
          <div>
            <div class="ac-name">${r.nombres}</div>
            <div class="ac-dni">DNI: ${r.dni} • Acumulado: ${r.horas_total_texto}</div>
          </div>
          <span class="status-pill ${r.dentro ? 'pill-in' : 'pill-out'}">
            ${r.dentro ? '🟢 En sala' : '⚪ Fuera'}
          </span>
        </div>
      `
      )
      .join('');

    autocompleteBox.classList.remove('hidden');

    autocompleteBox.querySelectorAll('.autocomplete-item').forEach((item) => {
      item.addEventListener('click', () => {
        const dni = item.getAttribute('data-dni');
        inputBusqueda.value = dni;
        selectedDni = dni;
        btnLimpiarInput.classList.remove('hidden');
        autocompleteBox.classList.add('hidden');
        consultarDniExacto(dni);
      });
    });
  }

  inputBusqueda.addEventListener('input', () => {
    const val = inputBusqueda.value.trim();
    selectedDni = '';
    btnLimpiarInput.classList.toggle('hidden', val.length === 0);

    if (searchTimeout) clearTimeout(searchTimeout);
    if (!val) {
      autocompleteBox.classList.add('hidden');
      resetPreview();
      return;
    }

    // Si son exactamente 8 dígitos numéricos, buscar directo el DNI
    const soloDigitos = val.replace(/\D/g, '');
    if (/^\d{8}$/.test(val) || (soloDigitos.length === 8 && val.length === 8)) {
      selectedDni = soloDigitos;
      autocompleteBox.classList.add('hidden');
      consultarDniExacto(soloDigitos).then((found) => {
        if (!found) {
          previewBox.classList.add('hidden');
          nuevoBox.classList.remove('hidden');
          inputNombresNuevo.classList.remove('hidden');
          btnSubmitMarca.className = 'btn btn-entrada btn-block';
          btnSubmitMarca.textContent = '✅ REGISTRARME Y MARCAR ENTRADA';
        }
      });
      return;
    }

    searchTimeout = setTimeout(async () => {
      try {
        if (currentSearchController) {
          currentSearchController.abort();
        }
        currentSearchController = new AbortController();
        const resp = await fetch(`/api/buscar?q=${encodeURIComponent(val)}`, {
          signal: currentSearchController.signal,
        });
        const data = await resp.json();
        if (data.ok) {
          renderAutocomplete(data.resultados);
          const exact = data.resultados.find((r) => r.exactDni);
          if (exact) {
            consultarDniExacto(exact.dni);
          }
        }
      } catch (_) {}
    }, 180);
  });

  btnLimpiarInput.addEventListener('click', () => {
    inputBusqueda.value = '';
    inputNombresNuevo.value = '';
    selectedDni = '';
    btnLimpiarInput.classList.add('hidden');
    autocompleteBox.classList.add('hidden');
    localStorage.removeItem('ultimo_dni_congreso');
    resetPreview();
    inputBusqueda.focus();
  });

  // Cerrar autocompletado al hacer clic fuera
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrapper')) {
      autocompleteBox.classList.add('hidden');
    }
  });

  function mostrarPaseConfirmacion(res) {
    const passBox = document.getElementById('pass-box');
    const passIcon = document.getElementById('pass-icon');
    const passBadge = document.getElementById('pass-badge');
    const passName = document.getElementById('pass-name');
    const passDni = document.getElementById('pass-dni');
    const stat1Label = document.getElementById('pass-stat1-label');
    const stat1Val = document.getElementById('pass-stat1-val');
    const stat2Label = document.getElementById('pass-stat2-label');
    const stat2Val = document.getElementById('pass-stat2-val');
    const passHoyVal = document.getElementById('pass-hoy-val');
    const passTotalVal = document.getElementById('pass-total-val');
    const passBlocksList = document.getElementById('pass-blocks-list');

    passName.textContent = res.participante.nombres;
    passDni.textContent = `DNI: ${res.participante.dni}`;
    passHoyVal.textContent = res.horas_hoy_texto;
    passTotalVal.textContent = res.horas_total_texto;

    if (res.tipo === 'ENTRADA') {
      passBox.className = 'pass-card pass-entrada';
      passIcon.textContent = '✅';
      passBadge.textContent = `ENTRADA REGISTRADA (BLOQUE #${res.numero_bloque_hoy})`;
      stat1Label.textContent = 'Hora de Entrada';
      stat1Val.textContent = res.hora_marca;
      stat2Label.textContent = 'Estado Actual';
      stat2Val.textContent = 'En Auditorio';
    } else {
      passBox.className = 'pass-card pass-salida';
      passIcon.textContent = '👋';
      passBadge.textContent = `SALIDA REGISTRADA (BLOQUE #${res.numero_bloque_hoy})`;
      stat1Label.textContent = 'Horario Bloque';
      stat1Val.textContent = `${res.hora_entrada_bloque} → ${res.hora_marca}`;
      stat2Label.textContent = 'Sumado en Bloque';
      stat2Val.textContent = `+${res.horas_bloque_texto}`;
    }

    passBlocksList.innerHTML = (res.bloques_hoy || [])
      .map(
        (b, i) => `
        <div class="block-row">
          <span><strong>Bloque ${i + 1}:</strong> ${b.hora_entrada_corta} a ${
          b.hora_salida_corta || 'En curso'
        }</span>
          <span class="status-pill ${b.hora_salida_corta ? 'pill-out' : 'pill-in'}">
            ${b.duracion_texto}
          </span>
        </div>
      `
      )
      .join('');

    viewForm.classList.add('hidden');
    viewPass.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function enviarMarca(forzar = false) {
    showError('');
    const rawInput = inputBusqueda.value.trim();
    if (!rawInput && !selectedDni) {
      showError('Ingresa tu número de DNI o escribe tu nombre.');
      inputBusqueda.focus();
      return;
    }

    // Determinar DNI, Nombres y Correo a enviar
    let dniEnviar = selectedDni;
    let nombresEnviar = inputNombresNuevo.value.trim();
    const inputCorreoNuevo = document.getElementById('input-correo-nuevo');
    const correoEnviar = inputCorreoNuevo ? inputCorreoNuevo.value.trim() : '';

    if (!dniEnviar) {
      const soloDigitos = rawInput.replace(/\D/g, '');
      if (soloDigitos.length >= 7) {
        dniEnviar = soloDigitos;
      } else {
        nombresEnviar = rawInput;
      }
    }

    let sesionPrevia = null;
    try {
      sesionPrevia = JSON.parse(localStorage.getItem('sesion_activa_congreso') || 'null');
    } catch (_) {}

    btnSubmitMarca.disabled = true;
    try {
      const resp = await fetch('/api/marcar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dni: dniEnviar,
          nombres: nombresEnviar,
          correo: correoEnviar,
          sesion_previa: sesionPrevia,
          forzar,
        }),
      });
      const data = await resp.json();

      if (!data.ok) {
        if (data.codigo === 'NO_ENCONTRADO_PEDIR_NOMBRE') {
          const dniNuevoEl = document.getElementById('input-dni-nuevo');
          if (dniNuevoEl && dniEnviar) dniNuevoEl.value = dniEnviar;
          inputNombresNuevo.classList.remove('hidden');
          inputNombresNuevo.focus();
          showError(
            'Tu DNI no está en la lista previa. Completa tu Nombre y Correo en el recuadro de abajo ("¿Recién te vas a registrar?").'
          );
        } else if (
          data.codigo === 'CONFIRMAR_SALIDA_RAPIDA' ||
          data.codigo === 'CONFIRMAR_REINGRESO_RAPIDO'
        ) {
          confirmRapidoMsg.textContent = data.mensaje;
          confirmRapidoBox.classList.remove('hidden');
        } else {
          showError(data.mensaje || 'No se pudo completar el registro.');
        }
        return;
      }

      // Guardar DNI y sesión activa en el celular del participante
      if (data.participante?.dni) {
        localStorage.setItem('ultimo_dni_congreso', data.participante.dni);
        if (data.tipo === 'ENTRADA') {
          localStorage.setItem(
            'sesion_activa_congreso',
            JSON.stringify({
              dni: data.participante.dni,
              fecha: data.fecha,
              hora_entrada: data.hora_marca,
            })
          );
        } else {
          localStorage.removeItem('sesion_activa_congreso');
        }
      }

      confirmRapidoBox.classList.add('hidden');
      mostrarPaseConfirmacion(data);
    } catch (err) {
      showError('Error de conexión con el servidor. Intenta nuevamente.');
    } finally {
      btnSubmitMarca.disabled = false;
    }
  }

  const btnSubmitNuevo = document.getElementById('btn-submit-nuevo');
  const inputDniNuevo = document.getElementById('input-dni-nuevo');
  const errorNuevoBox = document.getElementById('error-nuevo-box');

  function showErrorNuevo(msg) {
    if (!errorNuevoBox) return;
    if (!msg) {
      errorNuevoBox.classList.add('hidden');
      errorNuevoBox.textContent = '';
      return;
    }
    errorNuevoBox.textContent = msg;
    errorNuevoBox.classList.remove('hidden');
  }

  async function enviarNuevoAsistente() {
    showErrorNuevo('');
    const dniVal = (inputDniNuevo ? inputDniNuevo.value.trim() : '') || inputBusqueda.value.trim();
    const nombresVal = inputNombresNuevo ? inputNombresNuevo.value.trim() : '';
    const correoVal = inputCorreoNuevo ? inputCorreoNuevo.value.trim() : '';

    if (!dniVal || dniVal.replace(/\D/g, '').length < 6) {
      showErrorNuevo('Ingresa un número de DNI válido.');
      if (inputDniNuevo) inputDniNuevo.focus();
      return;
    }
    if (!nombresVal) {
      showErrorNuevo('Ingresa tus Nombres y Apellidos completos.');
      if (inputNombresNuevo) inputNombresNuevo.focus();
      return;
    }

    if (btnSubmitNuevo) btnSubmitNuevo.disabled = true;
    try {
      const resp = await fetch('/api/marcar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dni: dniVal,
          nombres: nombresVal,
          correo: correoVal,
          forzar: true,
        }),
      });
      const data = await resp.json();
      if (!data.ok) {
        showErrorNuevo(data.mensaje || 'No se pudo completar el registro.');
        return;
      }

      if (data.participante?.dni) {
        localStorage.setItem('ultimo_dni_congreso', data.participante.dni);
        if (data.tipo === 'ENTRADA') {
          localStorage.setItem(
            'sesion_activa_congreso',
            JSON.stringify({
              dni: data.participante.dni,
              fecha: data.fecha,
              hora_entrada: data.hora_marca,
            })
          );
        }
      }
      if (inputDniNuevo) inputDniNuevo.value = '';
      if (inputNombresNuevo) inputNombresNuevo.value = '';
      if (inputCorreoNuevo) inputCorreoNuevo.value = '';
      mostrarPaseConfirmacion(data);
    } catch (_) {
      showErrorNuevo('Error de conexión con el servidor.');
    } finally {
      if (btnSubmitNuevo) btnSubmitNuevo.disabled = false;
    }
  }

  if (btnSubmitNuevo) {
    btnSubmitNuevo.addEventListener('click', enviarNuevoAsistente);
  }

  btnSubmitMarca.addEventListener('click', () => enviarMarca(false));
  btnForzarMarca.addEventListener('click', () => enviarMarca(true));
  btnCancelarForzar.addEventListener('click', () => {
    confirmRapidoBox.classList.add('hidden');
  });

  inputBusqueda.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      autocompleteBox.classList.add('hidden');
      enviarMarca(false);
    }
  });

  inputNombresNuevo.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      enviarMarca(false);
    }
  });

  btnVolverInicio.addEventListener('click', () => {
    viewPass.classList.add('hidden');
    viewForm.classList.remove('hidden');
    const guardado = localStorage.getItem('ultimo_dni_congreso');
    if (guardado) {
      inputBusqueda.value = guardado;
      selectedDni = guardado;
      btnLimpiarInput.classList.remove('hidden');
      consultarDniExacto(guardado);
    } else {
      resetPreview();
    }
  });

  // Si el participante ya registró antes desde este mismo celular, precargar su DNI para ahorrarle tiempo en su salida/reingreso
  const dniGuardado = localStorage.getItem('ultimo_dni_congreso');
  if (dniGuardado) {
    inputBusqueda.value = dniGuardado;
    selectedDni = dniGuardado;
    btnLimpiarInput.classList.remove('hidden');
    consultarDniExacto(dniGuardado);
  }
})();
