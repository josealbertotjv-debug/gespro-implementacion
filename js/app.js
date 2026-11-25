/* =====================================================================
   GesPro Pulse · Controlador principal de la aplicación
   Cero dependencias externas · Persistencia localStorage · Gráficos SVG
   ===================================================================== */

(() => {
const { ACADEMIA_URL, FASES_PLANTILLA, MODULOS_CATALOGO, crearDatosIniciales, crearEmpresaNueva } = window.GesProPulseData;

const STORAGE_KEY = 'gespro_pulse_estado_v1';
const THEME_KEY = 'gespro_pulse_tema_v1';
const SERVER_URL_KEY = 'gespro_pulse_server_url_v1';
const PUBLIC_BASE_URL_KEY = 'gespro_pulse_public_base_v1';
const DEFAULT_GESPRO_URL = 'https://gespro-administrativo.gespro.ai';
const DEFAULT_PUBLIC_BASE = 'https://implementacion.gespro.ai/';

const state = {
  data: cargarDatos(),
  empresaId: null,
  tab: 'resumen',
  modo: 'cliente', // 'cliente' | 'consultor'
  exclusivoCliente: false, // true cuando se abre un enlace privado #cliente=...
  accesoUsuarios: false,   // true cuando se abre /?acceso=1 (portal de acceso para usuarios de GesPro)
  autenticadoPortal: false,
  servidorVivo: false,
  esLocal: false,
  faseSeleccionadaResumen: null,
  filtroFlujo: 'todas',
  filtroRespFlujo: 'todos',
  filtroModCat: 'Todas',
  filtroBloqueo: 'abiertos',
  busquedaPortafolio: '',
  filtroPortafolio: 'todas',
  seriesActivas: { facturas: true, cobrosPagos: true, inventario: true, asientos: false },
};

/* ---------------- Utilidades ---------------- */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtNum(n) {
  return new Intl.NumberFormat('es-VE').format(Number(n || 0));
}

function fmtFecha(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${Number(d)} ${meses[Number(m) - 1] || m} ${y}`;
}

function iniciales(nombre) {
  return String(nombre || 'GP')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('') || 'GP';
}

function ahoraTexto() {
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function leerJsonSeguro(res) {
  const texto = await res.text();
  try {
    return texto ? JSON.parse(texto) : {};
  } catch {
    if (res.status === 405 || res.status === 404) {
      throw new Error('Este portal está en modo estático (GitHub Pages) y no dispone del conector en vivo. Abre tu panel local (http://127.0.0.1:4355) o el enlace en vivo para sincronizar con GesPro.');
    }
    throw new Error(`El servidor respondió con un formato inesperado (HTTP ${res.status}). Inténtalo de nuevo en unos segundos.`);
  }
}

function mensajeErrorRed(err) {
  const m = String(err?.message || err || '');
  if (/load failed|failed to fetch|networkerror|abort/i.test(m)) {
    return 'No se pudo establecer conexión con el servidor. Verifica tu conexión a internet o que el servidor local/túnel esté encendido.';
  }
  if (/did not match the expected pattern|unexpected token|json/i.test(m)) {
    return 'El servidor devolvió una respuesta no válida para sincronización en vivo. Asegúrate de estar conectado al servidor Node de GesPro Pulse y no a la versión estática.';
  }
  return m || 'Ocurrió un error al conectar con GesPro.';
}

function cargarDatos() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.empresas) && parsed.empresas.length) return parsed;
    }
  } catch {}
  return crearDatosIniciales();
}

function guardarDatos() {
  state.data.actualizadoEn = ahoraTexto();
  if (state.exclusivoCliente || state.accesoUsuarios) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
  } catch {}
}

/* ---------------- Codificación compacta de enlace privado #cliente=... ---------------- */
function bytesABase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlABytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function codificarSnapshotCliente(emp) {
  const paquete = {
    v: 1,
    at: state.data.actualizadoEn || ahoraTexto(),
    emp,
  };
  const raw = new TextEncoder().encode(JSON.stringify(paquete));
  if (typeof CompressionStream === 'function') {
    const cs = new CompressionStream('deflate-raw');
    const w = cs.writable.getWriter();
    w.write(raw);
    w.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    return 'z.' + bytesABase64Url(new Uint8Array(buf));
  }
  return 'p.' + bytesABase64Url(raw);
}

async function decodificarSnapshotCliente(token) {
  try {
    if (!token || token.length < 6) return null;
    const modo = token.slice(0, 2);
    const body = token.slice(2);
    const bytes = base64UrlABytes(body);
    let jsonTxt;
    if (modo === 'z.' && typeof DecompressionStream === 'function') {
      const ds = new DecompressionStream('deflate-raw');
      const w = ds.writable.getWriter();
      w.write(bytes);
      w.close();
      jsonTxt = await new Response(ds.readable).text();
    } else if (modo === 'p.') {
      jsonTxt = new TextDecoder().decode(bytes);
    } else {
      return null;
    }
    const parsed = JSON.parse(jsonTxt);
    if (!parsed?.emp?.nombre || !Array.isArray(parsed.emp.fases)) return null;
    return parsed;
  } catch {
    return null;
  }
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

/* ---------------- Motor de métricas en tiempo real ---------------- */
function calcFase(fase) {
  const total = fase.tareas.length || 1;
  const done = fase.tareas.filter((t) => t.estado === 'completado').length;
  const progress = fase.tareas.filter((t) => t.estado === 'en_curso').length;
  const blocked = fase.tareas.filter((t) => t.estado === 'bloqueado').length;
  const pending = fase.tareas.filter((t) => t.estado === 'pendiente').length;
  const pct = Math.round((done / total) * 100);

  let status = 'pending';
  let label = 'Pendiente';
  if (done === total) { status = 'done'; label = 'Completada'; }
  else if (blocked > 0) { status = 'blocked'; label = 'Con bloqueo'; }
  else if (done > 0 || progress > 0) { status = 'active'; label = 'En curso'; }

  return { total, done, progress, blocked, pending, pct, status, label };
}

function calcEmpresa(emp) {
  const fasesCalc = emp.fases.map((f) => ({ ...f, m: calcFase(f) }));
  const totalTareas = fasesCalc.reduce((a, f) => a + f.m.total, 0);
  const doneTareas = fasesCalc.reduce((a, f) => a + f.m.done, 0);
  const blockedTareas = fasesCalc.reduce((a, f) => a + f.m.blocked, 0);
  const avanceImpl = totalTareas ? Math.round((doneTareas / totalTareas) * 100) : 0;

  const faseActual = fasesCalc.find((f) => f.m.status !== 'done') || fasesCalc[fasesCalc.length - 1];

  // Índice de uso: promedio de adopción de módulos contratados/habilitados
  const modsEvaluables = emp.modulos.filter((m) => m.estado !== 'pendiente');
  const indiceUso = modsEvaluables.length
    ? Math.round(modsEvaluables.reduce((a, m) => a + Number(m.adopcion || 0), 0) / modsEvaluables.length)
    : 0;

  const modsActivos = emp.modulos.filter((m) => m.estado === 'activo').length;
  const modsAlerta = emp.modulos.filter((m) => m.estado === 'sin_uso').length;
  const modsParciales = emp.modulos.filter((m) => m.estado === 'parcial').length;

  let semaforoUso = { clase: 'info', texto: 'En preparación', caption: 'Aún en configuración inicial' };
  if (avanceImpl >= 75 && indiceUso < 50) {
    semaforoUso = { clase: 'danger', texto: 'Alerta de subuso', caption: 'Implementado con bajo uso real' };
  } else if (indiceUso >= 75) {
    semaforoUso = { clase: 'ok', texto: 'Uso activo', caption: 'Operación diaria saludable' };
  } else if (indiceUso >= 45) {
    semaforoUso = { clase: 'warn', texto: 'Adopción parcial', caption: 'Áreas en transición o piloto' };
  } else if (modsEvaluables.length > 0) {
    semaforoUso = { clase: 'warn', texto: 'Uso inicial', caption: 'Iniciando registros operativos' };
  }

  const usuariosTotal = emp.usuarios.length;
  const usuariosActivos = emp.usuarios.filter((u) => Number(u.sesionesSemana || 0) > 0).length;
  const usuariosPct = usuariosTotal ? Math.round((usuariosActivos / usuariosTotal) * 100) : 0;

  const docs30d = emp.modulos.reduce((a, m) => a + Number(m.docs30d || 0), 0);
  const bloqueosAbiertos = emp.bloqueos.filter((b) => !b.resuelto);
  const bloqueosAlta = bloqueosAbiertos.filter((b) => b.prioridad === 'alta').length;
  const bloqueosCliente = bloqueosAbiertos.filter((b) => b.responsable === 'Cliente' || b.responsable === 'Ambos').length;

  // Tendencia de últimas 2 semanas
  const act = emp.actividadSemanal || [];
  let tendenciaSem = 0;
  if (act.length >= 2) {
    const sum = (w) => (w.facturas || 0) + (w.cobrosPagos || 0) + (w.inventario || 0);
    const ult = sum(act[act.length - 1]);
    const prev = sum(act[act.length - 2]);
    tendenciaSem = prev > 0 ? Math.round(((ult - prev) / prev) * 100) : 0;
  }

  let estadoGeneral = { clase: 'info', texto: 'En implementación' };
  if (avanceImpl >= 85 && indiceUso >= 75 && bloqueosAlta === 0) {
    estadoGeneral = { clase: 'ok', texto: 'Producción estable' };
  } else if (semaforoUso.clase === 'danger' || bloqueosAlta > 0 || blockedTareas > 0) {
    estadoGeneral = { clase: 'danger', texto: semaforoUso.clase === 'danger' ? 'Alerta de adopción' : 'Requiere atención' };
  } else if (avanceImpl >= 50) {
    estadoGeneral = { clase: 'warn', texto: 'Piloto / Go-Live próximo' };
  }

  return {
    fasesCalc,
    totalTareas,
    doneTareas,
    blockedTareas,
    avanceImpl,
    faseActual,
    indiceUso,
    modsActivos,
    modsParciales,
    modsAlerta,
    modsEvaluablesCount: modsEvaluables.length,
    semaforoUso,
    usuariosTotal,
    usuariosActivos,
    usuariosPct,
    docs30d,
    tendenciaSem,
    bloqueosAbiertos,
    bloqueosAlta,
    bloqueosCliente,
    estadoGeneral,
  };
}

function empresaActual() {
  let emp = state.data.empresas.find((e) => e.id === state.empresaId);
  if (!emp) {
    emp = state.data.empresas[0];
    state.empresaId = emp?.id || null;
  }
  return emp;
}

function moduloMeta(id) {
  return MODULOS_CATALOGO.find((m) => m.id === id) || { id, icono: '🧩', nombre: id, categoria: 'Otros', academia: 'Academia GesPro' };
}

/* ---------------- Componentes SVG (cero librerías) ---------------- */
function svgGauge(pct, colorStart, colorEnd, label, caption) {
  const clamped = Math.max(0, Math.min(100, Number(pct || 0)));
  const r = 46;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - clamped / 100);
  const gradId = `g-${Math.random().toString(36).slice(2, 8)}`;
  return `
    <div class="gauge-card">
      <div class="gauge-ring">
        <svg viewBox="0 0 112 112" aria-hidden="true">
          <defs>
            <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stop-color="${colorStart}"/>
              <stop offset="100%" stop-color="${colorEnd}"/>
            </linearGradient>
          </defs>
          <circle cx="56" cy="56" r="${r}" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="10"/>
          <circle cx="56" cy="56" r="${r}" fill="none" stroke="url(#${gradId})" stroke-width="10"
            stroke-linecap="round" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"/>
        </svg>
        <div class="gauge-center">
          <span class="gauge-val num">${clamped}%</span>
          <span class="gauge-sub">${esc(label)}</span>
        </div>
      </div>
      <div class="gauge-title">${esc(caption.title)}</div>
      <div class="gauge-caption">${esc(caption.sub)}</div>
    </div>
  `;
}

function svgSparkline(values, color = '#1a5da8') {
  if (!values || values.length < 2) return '';
  const w = 104, h = 28, pad = 3;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `
    <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <polyline fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" points="${pts.join(' ')}"/>
    </svg>
  `;
}

function svgActivityChart(semanas, seriesActivas, chartId) {
  if (!semanas || !semanas.length) {
    return `<div class="empty-box">Sin actividad operativa registrada aún.</div>`;
  }
  const SERIES = [
    { key: 'facturas', nombre: 'Facturas y Pedidos', color: '#1a5da8' },
    { key: 'cobrosPagos', nombre: 'Cobros y Pagos', color: '#10b981' },
    { key: 'inventario', nombre: 'Mov. Inventario', color: '#f59e0b' },
    { key: 'asientos', nombre: 'Asientos Contables', color: '#7c3aed' },
  ];
  const activas = SERIES.filter((s) => seriesActivas[s.key]);
  const usar = activas.length ? activas : [SERIES[0]];

  const W = 680, H = 235;
  const padL = 44, padR = 18, padT = 16, padB = 34;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  let maxVal = 10;
  for (const w of semanas) {
    for (const s of usar) maxVal = Math.max(maxVal, Number(w[s.key] || 0));
  }
  const niceMax = Math.ceil(maxVal / 10) * 10;
  const xAt = (i) => semanas.length === 1 ? padL + innerW / 2 : padL + (i / (semanas.length - 1)) * innerW;
  const yAt = (v) => padT + innerH - (Number(v || 0) / niceMax) * innerH;

  let gridLines = '';
  for (let i = 0; i <= 4; i++) {
    const val = Math.round((niceMax / 4) * i);
    const y = yAt(val);
    gridLines += `
      <line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-dasharray="${i === 0 ? '' : '3 4'}"/>
      <text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="var(--muted)" font-size="11">${val}</text>
    `;
  }

  let paths = '';
  for (const s of usar) {
    const pts = semanas.map((w, i) => [xAt(i), yAt(w[s.key])]);
    const lineD = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const areaD = `${lineD} L${pts[pts.length - 1][0].toFixed(1)},${(padT + innerH).toFixed(1)} L${pts[0][0].toFixed(1)},${(padT + innerH).toFixed(1)} Z`;
    paths += `<path d="${areaD}" fill="${s.color}" opacity="0.08"/>`;
    paths += `<path d="${lineD}" fill="none" stroke="${s.color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
    for (let i = 0; i < pts.length; i++) {
      paths += `<circle cx="${pts[i][0].toFixed(1)}" cy="${pts[i][1].toFixed(1)}" r="4" fill="var(--surface)" stroke="${s.color}" stroke-width="2.4"/>`;
    }
  }

  let xLabels = '';
  let hitZones = '';
  const stepW = innerW / Math.max(semanas.length, 1);
  semanas.forEach((w, i) => {
    const x = xAt(i);
    xLabels += `<text x="${x.toFixed(1)}" y="${H - 10}" text-anchor="middle" fill="var(--muted)" font-size="11.5" font-weight="600">${esc(w.sem)}</text>`;
    hitZones += `<rect x="${(x - stepW / 2).toFixed(1)}" y="${padT}" width="${stepW.toFixed(1)}" height="${innerH}" fill="transparent" class="chart-hit" data-idx="${i}" data-chart="${chartId}" style="cursor:crosshair"/>`;
  });

  const legend = SERIES.map((s) => {
    const on = !!seriesActivas[s.key];
    return `
      <button type="button" class="chip ${on ? 'active' : ''}" data-toggle-series="${s.key}" style="${on ? `background:${s.color};border-color:${s.color};color:#fff;` : ''}">
        <span class="leg-dot" style="background:${on ? '#fff' : s.color};display:inline-block;margin-right:4px"></span>${esc(s.nombre)}
      </button>
    `;
  }).join('');

  return `
    <div class="chart-box" id="${chartId}">
      <div class="chart-legend">${legend}</div>
      <div class="chart-tooltip" id="${chartId}-tip"></div>
      <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución semanal de operaciones en GesPro">
        ${gridLines}
        ${paths}
        ${xLabels}
        ${hitZones}
      </svg>
    </div>
  `;
}

/* ---------------- Renderizado de Cabecera y Navegación ---------------- */
function renderChrome() {
  const emp = empresaActual();
  const enPuertaAcceso = state.accesoUsuarios && !state.autenticadoPortal;
  const soloLecturaCliente = state.exclusivoCliente || state.accesoUsuarios;

  const picker = document.getElementById('companyPickerWrap');
  const modeSwitch = document.querySelector('.mode-switch');
  const btnConnectTop = document.getElementById('btnConnectTop');
  const btnShare = document.getElementById('btnShare');
  const btnPrint = document.getElementById('btnPrint');
  const subnav = document.querySelector('.subnav');
  const footerLinks = document.querySelector('.footer-links');

  if (enPuertaAcceso) {
    if (picker) picker.style.display = 'none';
    if (modeSwitch) modeSwitch.style.display = 'none';
    if (btnConnectTop) btnConnectTop.style.display = 'none';
    if (btnShare) btnShare.style.display = 'none';
    if (btnPrint) btnPrint.style.display = 'none';
    if (subnav) subnav.style.display = 'none';
    if (footerLinks) footerLinks.style.display = 'none';
    return;
  }

  if (subnav) subnav.style.display = '';
  if (btnPrint) btnPrint.style.display = '';
  if (picker) picker.style.display = (state.exclusivoCliente || state.data.empresas.length <= 1) ? 'none' : '';
  if (modeSwitch) modeSwitch.style.display = soloLecturaCliente ? 'none' : '';
  if (btnShare) btnShare.style.display = state.exclusivoCliente ? 'none' : '';
  if (btnConnectTop) {
    btnConnectTop.style.display = state.exclusivoCliente ? 'none' : (state.servidorVivo ? '' : 'none');
  }
  const btnConnectFooter = document.getElementById('btnConnectLive');
  if (btnConnectFooter) {
    btnConnectFooter.style.display = state.servidorVivo ? '' : 'none';
    const nextSep = btnConnectFooter.nextElementSibling;
    if (nextSep?.classList.contains('sep')) nextSep.style.display = state.servidorVivo ? '' : 'none';
  }
  if (footerLinks) footerLinks.style.display = soloLecturaCliente ? 'none' : '';

  if (!emp) return;
  const m = calcEmpresa(emp);

  // Selector de empresas
  const sel = document.getElementById('companySelect');
  sel.innerHTML = state.data.empresas.map((e) => {
    const em = calcEmpresa(e);
    return `<option value="${esc(e.id)}" ${e.id === emp.id ? 'selected' : ''}>${esc(e.nombre)} (${em.avanceImpl}%)</option>`;
  }).join('');

  // Botones de modo
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === state.modo);
  });

  // Tabs
  const tabs = [
    { id: 'resumen', ico: '📊', label: 'Resumen' },
    { id: 'flujo', ico: '🗺️', label: 'Implementación', cnt: `${m.doneTareas}/${m.totalTareas}` },
    { id: 'uso', ico: '📈', label: 'Uso y Adopción', cnt: `${m.indiceUso}%`, alert: m.semaforoUso.clase === 'danger' },
    { id: 'salud', ico: '⚡', label: 'Salud y Bloqueos', cnt: m.bloqueosAbiertos.length ? `${m.bloqueosAbiertos.length}` : '0', alert: m.bloqueosAlta > 0 },
  ];
  if (!state.exclusivoCliente && (!state.accesoUsuarios || state.data.empresas.length > 1)) {
    tabs.push({ id: 'portafolio', ico: '🏢', label: 'Empresas', cnt: `${state.data.empresas.length}` });
  } else if (state.tab === 'portafolio') {
    state.tab = 'resumen';
  }

  document.getElementById('mainTabs').innerHTML = tabs.map((t) => `
    <button type="button" role="tab" aria-selected="${state.tab === t.id}" class="tab ${state.tab === t.id ? 'active' : ''}" data-tab="${t.id}">
      <span aria-hidden="true">${t.ico}</span>
      <span>${esc(t.label)}</span>
      ${t.cnt !== undefined ? `<span class="cnt ${t.alert ? 'alert' : ''}">${esc(t.cnt)}</span>` : ''}
    </button>
  `).join('');

  // Meta derecha
  const badgeClass = m.estadoGeneral.clase === 'ok' ? '' : (m.estadoGeneral.clase === 'danger' ? 'danger' : 'warn');
  const origenTag = state.exclusivoCliente
    ? `<span class="pill ok">🔒 Vista exclusiva</span>`
    : state.data.fuenteReal
      ? `<span class="pill ok" title="Sincronizado desde ${esc(state.data.fuenteReal)}">● En vivo</span>`
      : `<span class="pill warn" title="Mostrando empresas de muestra">Demo</span>`;
  document.getElementById('subnavMeta').innerHTML = `
    ${origenTag}
    <span class="live-badge ${badgeClass}"><span class="dot"></span>${esc(m.estadoGeneral.texto)}</span>
    <span class="num">Actualizado: ${esc(state.data.actualizadoEn)}</span>
  `;

  const topLbl = document.getElementById('btnConnectTopLbl');
  if (topLbl) topLbl.textContent = (state.data.fuenteReal || state.accesoUsuarios) ? 'Actualizar en vivo' : 'Conectar GesPro';
}

function renderDemoBanner() {
  if (state.exclusivoCliente) {
    return `
      <div class="exclusive-ribbon">
        <div>
          <strong>Portal Ejecutivo de Cliente</strong> · Estás viendo el reporte oficial y exclusivo de seguimiento de <strong>${esc(empresaActual()?.nombre || '')}</strong> (corte: ${esc(state.data.actualizadoEn)}).
        </div>
        <button type="button" class="btn xs" onclick="window.print()">⎙ Guardar PDF</button>
      </div>
    `;
  }
  if (state.data.fuenteReal) return '';
  if (!state.servidorVivo) {
    return `
      <div class="demo-banner">
        <div>
          <strong>Portal en modo demostración</strong> · Para compartir el estado real de una empresa, sincronízala desde tu panel local y usa <strong>↗ Compartir</strong> para generar su enlace privado, o abre el portal en vivo.
        </div>
      </div>
    `;
  }
  return `
    <div class="demo-banner">
      <div>
        <strong>Vista con empresas de demostración</strong> · Conecta con tu servidor real de GesPro Administrativo (<code>${esc(localStorage.getItem(SERVER_URL_KEY) || DEFAULT_GESPRO_URL)}</code>) para cargar tus empresas, usuarios y actividad real en vivo.
      </div>
      <button type="button" class="btn sm ok" data-action="conectar-gespro">🔌 Cargar empresas reales</button>
    </div>
  `;
}

function renderPortalAcceso() {
  return `
    <section class="portal-gate">
      <div class="portal-gate-head">
        <span class="hero-kicker" style="margin-bottom:4px">Portal Oficial de Clientes · GesPro Administrativo</span>
        <h1>Consulta el estado de implementación y uso de tu empresa</h1>
        <p>Inicia sesión con tu usuario de <strong>GesPro Administrativo</strong> para consultar en tiempo real el avance de fases, módulos activos, usuarios y salud técnica de tu empresa.</p>
      </div>
      <div class="portal-gate-body">
        <form id="formPortalLogin" style="display:flex;flex-direction:column;gap:12px">
          <div id="gatePaso1" style="display:flex;flex-direction:column;gap:12px">
            <div class="field">
              <label for="gateUser">Usuario de GesPro</label>
              <input type="text" id="gateUser" required autocomplete="username" placeholder="Ej. admin">
            </div>
            <div class="field">
              <label for="gatePass">Contraseña</label>
              <input type="password" id="gatePass" required autocomplete="current-password" placeholder="••••••••">
            </div>
          </div>

          <div id="gatePaso2" style="display:none;flex-direction:column;gap:10px;padding:13px;border-radius:11px;background:var(--info-bg);border:1px solid var(--info-line)">
            <div style="font-size:13px;font-weight:700;color:var(--ink)">🔐 Verificación en dos pasos (2FA)</div>
            <div style="font-size:12.5px;color:var(--ink-2)" id="gate2faTxt">Ingresa el código de 6 dígitos de tu app autenticadora.</div>
            <div class="field">
              <label for="gate2faCode">Código de verificación</label>
              <input type="text" id="gate2faCode" inputmode="numeric" autocomplete="one-time-code" placeholder="000000" style="font-family:var(--mono);font-size:16px;letter-spacing:3px">
            </div>
          </div>

          <div id="gateMsg" style="font-size:13px;color:var(--muted)"></div>

          <button type="submit" class="btn primary" id="gateSubmit" style="padding:11px 16px;font-size:14px">
            Entrar y ver estado en vivo →
          </button>
        </form>
        <div style="font-size:12px;color:var(--muted);border-top:1px solid var(--line);padding-top:10px">
          🔒 Conexión de solo lectura con <code>gespro-administrativo.gespro.ai</code>. Solo verás las empresas asignadas a tu usuario y tu contraseña nunca se almacena.
        </div>
      </div>
    </section>
  `;
}

function bindPortalAccesoEvents() {
  const form = document.getElementById('formPortalLogin');
  if (!form) return;
  let tokenParcial = null;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('gateSubmit');
    const msg = document.getElementById('gateMsg');
    const usuario = document.getElementById('gateUser').value.trim();
    const password = document.getElementById('gatePass').value;

    let payload;
    if (tokenParcial) {
      const codigo = document.getElementById('gate2faCode').value.trim();
      if (!codigo) {
        msg.innerHTML = '<span style="color:var(--danger)">Ingresa el código de 6 dígitos.</span>';
        return;
      }
      payload = { url: DEFAULT_GESPRO_URL, token_parcial: tokenParcial, codigo };
    } else {
      if (!usuario || !password) {
        msg.innerHTML = '<span style="color:var(--danger)">Completa tu usuario y contraseña.</span>';
        return;
      }
      payload = { url: DEFAULT_GESPRO_URL, usuario, password };
    }

    btn.disabled = true;
    btn.textContent = '⏳ Consultando tu empresa en vivo…';
    msg.textContent = 'Verificando credenciales y leyendo estado real en GesPro…';

    try {
      const res = await fetch('/api/sincronizar-gespro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await leerJsonSeguro(res);
      if (!res.ok) throw new Error(json.error || `Error ${res.status}`);

      if (json.requiere_2fa) {
        tokenParcial = json.token_parcial;
        document.getElementById('gatePaso1').style.display = 'none';
        document.getElementById('gatePaso2').style.display = 'flex';
        document.getElementById('gate2faTxt').textContent = `Bienvenido, ${json.usuario?.nombre || usuario}. Ingresa tu código de 6 dígitos.`;
        msg.innerHTML = '';
        btn.disabled = false;
        btn.textContent = '✓ Verificar y continuar';
        document.getElementById('gate2faCode').focus();
        return;
      }

      const lista = (json.empresas || []).map((remote) => ({
        ...remote,
        fases: construirFasesDesdeHints(remote.faseHints, remote.fechaInicio, remote.fechaGoLive),
      }));
      if (!lista.length) throw new Error('Tu usuario no tiene empresas activas asignadas.');

      state.data = {
        version: 1,
        actualizadoEn: ahoraTexto(),
        fuenteReal: json.origen || DEFAULT_GESPRO_URL,
        empresas: lista,
      };
      state.empresaId = lista[0].id;
      state.autenticadoPortal = true;
      state.modo = 'cliente';
      state.tab = 'resumen';
      state.faseSeleccionadaResumen = null;
      render();
      toast(`✓ Datos en vivo cargados para ${lista.length} empresa(s)`);
    } catch (err) {
      msg.innerHTML = `<span style="color:var(--danger)">${esc(mensajeErrorRed(err))}</span>`;
      btn.disabled = false;
      btn.textContent = tokenParcial ? '✓ Verificar y continuar' : 'Entrar y ver estado en vivo →';
    }
  });
}

function renderConsultorRibbon(emp) {
  const demo = renderDemoBanner();
  if (state.modo !== 'consultor') return demo;
  return `${demo}
    <div class="consultor-ribbon">
      <div>
        <strong>Modo Consultor activo</strong> · Puedes marcar tareas, actualizar uso por módulo, resolver bloqueos o registrar nuevas empresas. Todo se guarda al instante.
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn sm primary" data-action="nueva-empresa">+ Nueva Empresa</button>
        <button type="button" class="btn sm" data-action="editar-empresa">✎ Editar ficha de ${esc(emp.codigo)}</button>
      </div>
    </div>
  `;
}

/* ---------------- VISTA 1: RESUMEN EJECUTIVO ---------------- */
function renderResumen(emp, m) {
  if (!state.faseSeleccionadaResumen || !emp.fases.some((f) => f.id === state.faseSeleccionadaResumen)) {
    state.faseSeleccionadaResumen = m.faseActual.id;
  }
  const faseSel = m.fasesCalc.find((f) => f.id === state.faseSeleccionadaResumen) || m.faseActual;

  const gaugeUsoColors = m.semaforoUso.clase === 'ok'
    ? ['#0f766e', '#34d399']
    : m.semaforoUso.clase === 'danger'
      ? ['#be123c', '#fb7185']
      : ['#d97706', '#fbbf24'];

  const sparkVals = (emp.actividadSemanal || []).map((w) => (w.facturas || 0) + (w.cobrosPagos || 0) + (w.inventario || 0));

  const pipelineHtml = m.fasesCalc.map((f) => `
    <div class="phase-node ${f.m.status} ${f.id === faseSel.id ? 'selected' : ''}" data-select-phase="${f.id}" role="button" tabindex="0">
      <div class="phase-step-row">
        <span class="phase-num">${f.m.status === 'done' ? '✓' : f.numero}</span>
        <span class="pill ${f.m.status === 'done' ? 'ok' : f.m.status === 'blocked' ? 'danger' : f.m.status === 'active' ? 'info' : 'neutral'}">${esc(f.m.label)}</span>
      </div>
      <div class="phase-title">${esc(f.corto)}</div>
      <div class="prog-bar sm ${f.m.status === 'done' ? 'ok' : f.m.status === 'blocked' ? 'danger' : ''}">
        <div style="width:${f.m.pct}%"></div>
      </div>
      <div class="phase-sub num">
        <span>${f.m.done}/${f.m.total} tareas</span>
        <strong>${f.m.pct}%</strong>
      </div>
    </div>
  `).join('');

  const drawerTareas = faseSel.tareas.map((t) => renderTaskRow(emp, faseSel, t)).join('');

  // Top alertas y módulos destacados
  const modsConAlerta = emp.modulos.filter((x) => x.estado === 'sin_uso');
  const modsActivosList = emp.modulos.filter((x) => x.estado === 'activo').sort((a, b) => b.docs30d - a.docs30d).slice(0, 4);

  const alertasResumenHtml = [
    ...modsConAlerta.map((mod) => {
      const meta = moduloMeta(mod.id);
      return `
        <div class="blocker-card prio-alta" style="padding:11px 13px">
          <div>
            <h4>${meta.icono} Bajo uso en ${esc(meta.nombre)}</h4>
            <p style="margin-bottom:4px">${esc(mod.nota)}</p>
            <div class="blocker-tags">
              <span class="pill danger">Último uso: ${esc(mod.ultimoUso)}</span>
              <span class="pill neutral">Adopción: ${mod.adopcion}%</span>
            </div>
          </div>
          <button type="button" class="btn xs" data-goto-tab="uso">Ver módulo →</button>
        </div>
      `;
    }),
    ...m.bloqueosAbiertos.slice(0, 3).map((b) => `
      <div class="blocker-card prio-${b.prioridad}" style="padding:11px 13px">
        <div>
          <h4>${esc(b.titulo)}</h4>
          <p style="margin-bottom:4px">${esc(b.descripcion)}</p>
          <div class="blocker-tags">
            <span class="pill ${b.prioridad === 'alta' ? 'danger' : b.prioridad === 'media' ? 'warn' : 'info'}">Prioridad ${esc(b.prioridad)}</span>
            <span class="pill neutral">Responsable: ${esc(b.responsable)}</span>
            <span class="pill neutral">Meta: ${fmtFecha(b.fechaLimite)}</span>
          </div>
        </div>
        <button type="button" class="btn xs" data-goto-tab="salud">Gestionar →</button>
      </div>
    `),
  ].join('') || `
    <div class="empty-box" style="padding:20px">
      <div style="font-size:22px;margin-bottom:4px">✅</div>
      <strong>Sin bloqueos ni alertas de uso</strong>
      <div style="font-size:12.5px;margin-top:3px">Todos los módulos habilitados presentan operación saludable.</div>
    </div>
  `;

  return `
    ${renderConsultorRibbon(emp)}

    <section class="exec-hero">
      <div>
        <div class="hero-kicker">
          <span class="code-tag">${esc(emp.codigo)}</span>
          <span>${esc(emp.sector)}</span>
        </div>
        <h1>${esc(emp.nombre)}</h1>
        <div class="hero-meta-grid">
          <span>🪪 RIF: <strong>${esc(emp.rif)}</strong></span>
          <span>☁ Entorno: <strong>${esc(emp.plan)}</strong></span>
          <span>👤 Consultor: <strong>${esc(emp.consultor)}</strong></span>
          <span>🎯 Sponsor: <strong>${esc(emp.sponsorCliente)}</strong></span>
          <span>📅 Go-Live meta: <strong>${fmtFecha(emp.fechaGoLive)}</strong></span>
        </div>
        <div class="hero-status-note">
          <span style="font-size:18px;line-height:1.2" aria-hidden="true">${m.estadoGeneral.clase === 'danger' ? '⚠️' : m.estadoGeneral.clase === 'ok' ? '✅' : '🚀'}</span>
          <div>
            <strong style="display:block;color:#fff;margin-bottom:2px">Estado actual · Fase ${m.faseActual.numero}: ${esc(m.faseActual.nombre)}</strong>
            <span>${esc(emp.resumenEjecutivo)}</span>
          </div>
        </div>
      </div>

      <div class="hero-gauges">
        ${svgGauge(m.avanceImpl, '#3892e8', '#34d399', 'Avance', {
          title: 'Implementación',
          sub: `${m.doneTareas} de ${m.totalTareas} hitos listos`,
        })}
        ${svgGauge(m.indiceUso, gaugeUsoColors[0], gaugeUsoColors[1], 'Adopción', {
          title: m.semaforoUso.texto,
          sub: m.semaforoUso.caption,
        })}
      </div>
    </section>

    <section class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">Sistema y Servidor</span>
          <span class="kpi-ico">🖥</span>
        </div>
        <div class="kpi-value num">${esc(emp.infraestructura.uptime)}%</div>
        <div class="kpi-foot">
          <span class="pill ok">● ${esc(emp.infraestructura.estado)}</span>
          <span class="mono">${esc(emp.infraestructura.version)}</span>
        </div>
      </div>

      <div class="kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">Usuarios Activos (7d)</span>
          <span class="kpi-ico">👥</span>
        </div>
        <div class="kpi-value num">${m.usuariosActivos} <span style="font-size:15px;font-weight:600;color:var(--muted)">/ ${m.usuariosTotal}</span></div>
        <div class="prog-bar sm ${m.usuariosPct >= 75 ? 'ok' : m.usuariosPct >= 50 ? 'warn' : 'danger'}">
          <div style="width:${m.usuariosPct}%"></div>
        </div>
        <div class="kpi-foot">
          <span>${m.usuariosPct}% del equipo ingresó</span>
          <span>2FA: ${emp.infraestructura.adopcion2fa}%</span>
        </div>
      </div>

      <div class="kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">Operaciones (30 días)</span>
          <span class="kpi-ico">📄</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <div class="kpi-value num">${fmtNum(m.docs30d)}</div>
          ${svgSparkline(sparkVals, m.tendenciaSem < 0 ? '#be123c' : '#0f766e')}
        </div>
        <div class="kpi-foot">
          <span class="pill ${m.tendenciaSem > 0 ? 'ok' : m.tendenciaSem < 0 ? 'danger' : 'neutral'}">${m.tendenciaSem > 0 ? '+' : ''}${m.tendenciaSem}% sem.</span>
          <span>${m.modsActivos} módulos activos</span>
        </div>
      </div>

      <div class="kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">Bloqueos y Compromisos</span>
          <span class="kpi-ico">🚦</span>
        </div>
        <div class="kpi-value num">${m.bloqueosAbiertos.length} <span style="font-size:14px;font-weight:600;color:var(--muted)">abiertos</span></div>
        <div class="kpi-foot">
          <span class="pill ${m.bloqueosAlta > 0 ? 'danger' : m.bloqueosAbiertos.length ? 'warn' : 'ok'}">${m.bloqueosAlta > 0 ? `${m.bloqueosAlta} alta prioridad` : m.bloqueosAbiertos.length ? 'En seguimiento' : 'Todo despejado'}</span>
          <span>Cliente: ${m.bloqueosCliente}</span>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <div>
          <h2>Flujo Interactivo de Implementación</h2>
          <p>Haz clic en cualquier fase para inspeccionar sus entregables, responsables y estado actual.</p>
        </div>
        <button type="button" class="btn sm" data-goto-tab="flujo">Ver cronograma completo →</button>
      </div>

      <div class="pipeline">${pipelineHtml}</div>

      <div class="phase-detail-drawer">
        <div class="card-head" style="margin-bottom:12px">
          <div>
            <h3 style="font-size:16px">Fase ${faseSel.numero}: ${esc(faseSel.nombre)}</h3>
            <p>${esc(faseSel.descripcion)} · <strong>${fmtFecha(faseSel.fechaInicio)} → ${fmtFecha(faseSel.fechaFin)}</strong></p>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <span class="pill ${faseSel.m.status === 'done' ? 'ok' : faseSel.m.status === 'blocked' ? 'danger' : faseSel.m.status === 'active' ? 'info' : 'neutral'}">${faseSel.m.pct}% completado</span>
            ${state.modo === 'consultor' ? `<button type="button" class="btn xs primary" data-add-task="${faseSel.id}">+ Tarea</button>` : ''}
          </div>
        </div>
        <div class="task-list">${drawerTareas}</div>
      </div>
    </section>

    <section class="grid-2-wide">
      <div class="card">
        <div class="card-head">
          <div>
            <h2>Pulso de Actividad Operativa</h2>
            <p>Volumen semanal registrado en GesPro Administrativo. Activa o desactiva series y pasa el cursor.</p>
          </div>
          <button type="button" class="btn sm" data-goto-tab="uso">Ver detalle de uso →</button>
        </div>
        ${svgActivityChart(emp.actividadSemanal, state.seriesActivas, 'chartResumen')}
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line);display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between">
          <div style="font-size:12.5px;color:var(--muted)">
            <strong style="color:var(--ink)">Módulos con mayor tracción:</strong>
            ${modsActivosList.length ? modsActivosList.map((x) => `${moduloMeta(x.id).icono} ${moduloMeta(x.id).nombre} (${fmtNum(x.docs30d)})`).join(' · ') : 'Aún en fase de configuración inicial.'}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <h2>Foco de Atención y Bloqueos</h2>
            <p>Elementos que requieren seguimiento de Gerencia o de GesPro.</p>
          </div>
          <button type="button" class="btn sm" data-goto-tab="salud">Ver todos →</button>
        </div>
        <div class="blocker-list">${alertasResumenHtml}</div>
      </div>
    </section>
  `;
}

function renderTaskRow(emp, fase, t) {
  const isCons = state.modo === 'consultor';
  const checkCls = t.estado === 'completado' ? 'done' : t.estado === 'en_curso' ? 'progress' : t.estado === 'bloqueado' ? 'blocked' : '';
  const checkSym = t.estado === 'completado' ? '✓' : t.estado === 'en_curso' ? '•' : t.estado === 'bloqueado' ? '!' : '';
  const estadoPill = t.estado === 'completado'
    ? '<span class="pill ok">Completado</span>'
    : t.estado === 'en_curso'
      ? '<span class="pill info">En curso</span>'
      : t.estado === 'bloqueado'
        ? '<span class="pill danger">Bloqueado</span>'
        : '<span class="pill neutral">Pendiente</span>';

  const respPill = t.responsable === 'Cliente'
    ? '<span class="pill warn">Cliente</span>'
    : t.responsable === 'GesPro'
      ? '<span class="pill info">GesPro</span>'
      : '<span class="pill neutral">Ambos</span>';

  return `
    <div class="task-row ${t.estado === 'bloqueado' ? 'is-blocked' : ''} ${t.estado === 'completado' ? 'is-done' : ''}">
      <button type="button" class="task-check ${checkCls} ${isCons ? '' : 'readonly'}"
        ${isCons ? `data-toggle-task="${fase.id}|${t.id}"` : 'disabled'}
        title="${isCons ? 'Marcar / desmarcar como completada' : 'Activa el Modo Consultor para editar'}">
        ${checkSym}
      </button>
      <div class="task-main">
        <h4>${esc(t.titulo)}</h4>
        <div class="task-meta">
          <span>📅 Compromiso: <strong>${fmtFecha(t.fechaCompromiso)}</strong></span>
          ${t.nota ? `<span>💬 ${esc(t.nota)}</span>` : ''}
        </div>
      </div>
      <div class="task-actions">
        ${respPill}
        ${isCons ? `
          <select class="status-select" data-task-status="${fase.id}|${t.id}" aria-label="Estado de tarea">
            <option value="pendiente" ${t.estado === 'pendiente' ? 'selected' : ''}>Pendiente</option>
            <option value="en_curso" ${t.estado === 'en_curso' ? 'selected' : ''}>En curso</option>
            <option value="completado" ${t.estado === 'completado' ? 'selected' : ''}>Completado</option>
            <option value="bloqueado" ${t.estado === 'bloqueado' ? 'selected' : ''}>Bloqueado</option>
          </select>
        ` : estadoPill}
      </div>
    </div>
  `;
}

/* ---------------- VISTA 2: FLUJO DE IMPLEMENTACIÓN ---------------- */
function renderFlujo(emp, m) {
  // Mini Gantt 8 semanas
  const todayWeek = Math.min(8, Math.max(1, m.faseActual.semanaInicio + (m.faseActual.m.pct / 100) * (m.faseActual.semanaFin - m.faseActual.semanaInicio + 1)));
  const todayPct = ((todayWeek - 0.5) / 8) * 100;

  const ganttRows = m.fasesCalc.map((f) => {
    const left = ((f.semanaInicio - 1) / 8) * 100;
    const width = ((f.semanaFin - f.semanaInicio + 1) / 8) * 100;
    return `
      <div class="gantt-row">
        <div class="gantt-lbl" title="${esc(f.nombre)}">${f.numero}. ${esc(f.nombre)}</div>
        <div class="gantt-track">
          <div class="gantt-today" style="left:${todayPct.toFixed(1)}%" title="Posición actual del proyecto"></div>
          <div class="gantt-bar ${f.m.status}" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%">
            <div class="gantt-fill" style="width:${f.m.pct}%"></div>
            <span class="gantt-pct num">${f.m.pct}%</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  const filtrosEstado = [
    { id: 'todas', label: 'Todas' },
    { id: 'en_curso', label: 'En curso' },
    { id: 'bloqueado', label: 'Bloqueadas' },
    { id: 'pendiente', label: 'Pendientes' },
    { id: 'completado', label: 'Completadas' },
  ];
  const filtrosResp = [
    { id: 'todos', label: 'Todos los responsables' },
    { id: 'Cliente', label: 'Solo Cliente' },
    { id: 'GesPro', label: 'Solo GesPro' },
    { id: 'Ambos', label: 'Compartidas' },
  ];

  const fasesCards = m.fasesCalc.map((f) => {
    const filtradas = f.tareas.filter((t) => {
      const okEst = state.filtroFlujo === 'todas' || t.estado === state.filtroFlujo;
      const okResp = state.filtroRespFlujo === 'todos' || t.responsable === state.filtroRespFlujo;
      return okEst && okResp;
    });
    if (!filtradas.length && (state.filtroFlujo !== 'todas' || state.filtroRespFlujo !== 'todos')) return '';
    return `
      <section class="card">
        <div class="card-head">
          <div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span class="phase-num" style="width:28px;height:28px;font-size:13px">${f.m.status === 'done' ? '✓' : f.numero}</span>
              <h3>${esc(f.nombre)}</h3>
              <span class="pill ${f.m.status === 'done' ? 'ok' : f.m.status === 'blocked' ? 'danger' : f.m.status === 'active' ? 'info' : 'neutral'}">${esc(f.m.label)} · ${f.m.pct}%</span>
            </div>
            <p>${esc(f.descripcion)} · <strong>${fmtFecha(f.fechaInicio)} al ${fmtFecha(f.fechaFin)}</strong></p>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:130px">
              <div class="prog-bar ${f.m.status === 'done' ? 'ok' : f.m.status === 'blocked' ? 'danger' : ''}">
                <div style="width:${f.m.pct}%"></div>
              </div>
              <div style="font-size:11.5px;color:var(--muted);text-align:right;margin-top:3px" class="num">${f.m.done}/${f.m.total} listas</div>
            </div>
            ${state.modo === 'consultor' ? `<button type="button" class="btn sm primary" data-add-task="${f.id}">+ Agregar tarea</button>` : ''}
          </div>
        </div>
        <div class="task-list">
          ${filtradas.map((t) => renderTaskRow(emp, f, t)).join('')}
        </div>
      </section>
    `;
  }).join('') || `<div class="empty-box">No hay tareas que coincidan con los filtros seleccionados.</div>`;

  return `
    ${renderConsultorRibbon(emp)}

    <section class="card">
      <div class="card-head">
        <div>
          <h2>Cronograma Visual de Implementación (8 Semanas)</h2>
          <p>Inicio: <strong>${fmtFecha(emp.fechaInicio)}</strong> · Salida en Vivo (Go-Live): <strong>${fmtFecha(emp.fechaGoLive)}</strong> · Avance global: <strong>${m.avanceImpl}%</strong></p>
        </div>
        <span class="pill info">Línea roja = avance actual</span>
      </div>
      <div class="gantt-wrap">
        <div class="gantt-grid">
          <div class="gantt-head">
            <div>Fase del proyecto</div>
            <div class="gantt-weeks">
              <span>Sem 1</span><span>Sem 2</span><span>Sem 3</span><span>Sem 4</span>
              <span>Sem 5</span><span>Sem 6</span><span>Sem 7</span><span>Sem 8</span>
            </div>
          </div>
          ${ganttRows}
        </div>
      </div>
    </section>

    <div class="filter-bar">
      <div class="filter-group">
        ${filtrosEstado.map((f) => `<button type="button" class="chip ${state.filtroFlujo === f.id ? 'active' : ''}" data-filter-flujo="${f.id}">${esc(f.label)}</button>`).join('')}
      </div>
      <div class="filter-group">
        ${filtrosResp.map((f) => `<button type="button" class="chip ${state.filtroRespFlujo === f.id ? 'active' : ''}" data-filter-resp="${f.id}">${esc(f.label)}</button>`).join('')}
      </div>
    </div>

    ${fasesCards}
  `;
}

/* ---------------- VISTA 3: ESTADO DE USO Y ADOPCIÓN ---------------- */
function renderUso(emp, m) {
  const categorias = ['Todas', 'Solo alertas', 'Ciclo Comercial', 'Tesorería', 'Operaciones', 'Personal', 'Administración'];

  const modsFiltrados = emp.modulos.filter((mod) => {
    const meta = moduloMeta(mod.id);
    if (state.filtroModCat === 'Todas') return true;
    if (state.filtroModCat === 'Solo alertas') return mod.estado === 'sin_uso' || mod.estado === 'parcial';
    return meta.categoria === state.filtroModCat;
  });

  const estadoMap = {
    activo: { cls: 'ok', txt: 'En uso activo' },
    parcial: { cls: 'warn', txt: 'Uso parcial' },
    sin_uso: { cls: 'danger', txt: 'Sin uso · Alerta' },
    pendiente: { cls: 'neutral', txt: 'No iniciado / Fase post.' },
  };

  const modCards = modsFiltrados.map((mod) => {
    const meta = moduloMeta(mod.id);
    const st = estadoMap[mod.estado] || estadoMap.pendiente;
    const barCls = mod.adopcion >= 75 ? 'ok' : mod.adopcion >= 45 ? 'warn' : 'danger';
    return `
      <div class="mod-card st-${mod.estado}" data-open-module="${mod.id}" role="button" tabindex="0">
        <div class="mod-head">
          <div class="mod-title-wrap">
            <div class="mod-ico">${meta.icono}</div>
            <div>
              <div class="mod-title">${esc(meta.nombre)}</div>
              <div class="mod-cat">${esc(meta.categoria)}</div>
            </div>
          </div>
          <span class="pill ${st.cls}">${st.txt}</span>
        </div>

        <div class="mod-metrics num">
          <div class="mod-m">
            <b>${fmtNum(mod.docs30d)}</b>
            <span>Ops. 30d</span>
          </div>
          <div class="mod-m">
            <b>${mod.usuariosActivos}/${mod.usuariosAsignados}</b>
            <span>Usuarios</span>
          </div>
          <div class="mod-m">
            <b style="color:${mod.tendencia > 0 ? 'var(--ok)' : mod.tendencia < 0 ? 'var(--danger)' : 'var(--muted)'}">${mod.tendencia > 0 ? '+' : ''}${mod.tendencia}%</b>
            <span>Tendencia</span>
          </div>
        </div>

        <div>
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
            <span style="color:var(--muted)">Nivel de adopción</span>
            <strong class="num">${mod.adopcion}%</strong>
          </div>
          <div class="prog-bar sm ${barCls}"><div style="width:${mod.adopcion}%"></div></div>
        </div>

        <div class="mod-foot">
          <span>🕒 ${esc(mod.ultimoUso)}</span>
          <span style="color:var(--brand);font-weight:600">${state.modo === 'consultor' ? 'Editar / Ver →' : 'Ver detalle →'}</span>
        </div>
      </div>
    `;
  }).join('') || `<div class="empty-box">No hay módulos en esta categoría.</div>`;

  const badgeUser = (est) => {
    if (est === 'campeon') return '<span class="pill ok">★ Campeón</span>';
    if (est === 'activo') return '<span class="pill info">Activo</span>';
    if (est === 'refuerzo') return '<span class="pill warn">Requiere refuerzo</span>';
    return '<span class="pill danger">Inactivo</span>';
  };

  return `
    ${renderConsultorRibbon(emp)}

    <section class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-top"><span class="kpi-label">Índice Global de Uso</span><span class="kpi-ico">🎯</span></div>
        <div class="kpi-value num">${m.indiceUso}%</div>
        <div class="kpi-foot"><span class="pill ${m.semaforoUso.clase}">${esc(m.semaforoUso.texto)}</span><span>${m.modsEvaluablesCount} módulos evaluados</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-top"><span class="kpi-label">Módulos Activos</span><span class="kpi-ico">✅</span></div>
        <div class="kpi-value num">${m.modsActivos} <span style="font-size:15px;color:var(--muted);font-weight:600">/ ${emp.modulos.length}</span></div>
        <div class="kpi-foot"><span>${m.modsParciales} en transición</span><span style="color:var(--danger);font-weight:700">${m.modsAlerta} sin uso</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-top"><span class="kpi-label">Equipo Activo Semanal</span><span class="kpi-ico">👥</span></div>
        <div class="kpi-value num">${m.usuariosPct}%</div>
        <div class="kpi-foot"><span>${m.usuariosActivos} de ${m.usuariosTotal} personas</span><span>Últimos 7 días</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-top"><span class="kpi-label">Transacciones (30 días)</span><span class="kpi-ico">📈</span></div>
        <div class="kpi-value num">${fmtNum(m.docs30d)}</div>
        <div class="kpi-foot"><span class="pill ${m.tendenciaSem >= 0 ? 'ok' : 'danger'}">${m.tendenciaSem >= 0 ? '+' : ''}${m.tendenciaSem}% vs sem. ant.</span><span>Total ERP</span></div>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <div>
          <h2>Semáforo de Uso por Módulo de GesPro</h2>
          <p>Haz clic en cualquier módulo para ver su diagnóstico, enlace directo a Academia GesPro ${state.modo === 'consultor' ? 'o editar sus métricas.' : 'y recomendaciones.'}</p>
        </div>
        <a href="${ACADEMIA_URL}" target="_blank" rel="noopener" class="btn sm">🎓 Abrir Academia GesPro ↗</a>
      </div>

      <div class="filter-bar">
        <div class="filter-group">
          ${categorias.map((c) => `<button type="button" class="chip ${state.filtroModCat === c ? 'active' : ''}" data-filter-mod="${esc(c)}">${esc(c)}</button>`).join('')}
        </div>
      </div>

      <div class="mod-grid">${modCards}</div>
    </section>

    <section class="card">
      <div class="card-head">
        <div>
          <h2>Tendencia Operativa Semanal</h2>
          <p>Verifica si el ritmo de registro real en el sistema crece de forma sostenida o si existe desaceleración.</p>
        </div>
      </div>
      ${svgActivityChart(emp.actividadSemanal, state.seriesActivas, 'chartUso')}
    </section>

    <section class="card">
      <div class="card-head">
        <div>
          <h2>Adopción por Área y Usuario Clave</h2>
          <p>Visibilidad clara de qué departamentos usan la aplicación diariamente y quién necesita acompañamiento.</p>
        </div>
        ${state.modo === 'consultor' ? `<button type="button" class="btn sm primary" data-action="nuevo-usuario">+ Agregar usuario</button>` : ''}
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Usuario y Área</th>
              <th>Rol ERP</th>
              <th>Sesiones / sem</th>
              <th>Operaciones (30d)</th>
              <th>Academia GesPro</th>
              <th>Último acceso</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody class="num">
            ${emp.usuarios.map((u) => `
              <tr>
                <td>
                  <div class="user-cell">
                    <div class="avatar">${esc(iniciales(u.nombre))}</div>
                    <div>
                      <div style="font-weight:700;color:var(--ink)">${esc(u.nombre)}</div>
                      <div style="font-size:12px;color:var(--muted)">${esc(u.area)}</div>
                    </div>
                  </div>
                </td>
                <td><span class="mono" style="font-size:12px;background:var(--surface-3);padding:3px 7px;border-radius:6px">${esc(u.rol)}</span></td>
                <td><strong>${u.sesionesSemana}</strong></td>
                <td><strong>${fmtNum(u.operaciones30d)}</strong></td>
                <td style="min-width:130px">
                  <div style="display:flex;align-items:center;gap:8px">
                    <div class="prog-bar sm ${u.academiaPct >= 80 ? 'ok' : u.academiaPct >= 50 ? 'warn' : 'danger'}"><div style="width:${u.academiaPct}%"></div></div>
                    <span style="font-size:12px;font-weight:700">${u.academiaPct}%</span>
                  </div>
                </td>
                <td>${esc(u.ultimoAcceso)}</td>
                <td>${badgeUser(u.estado)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

/* ---------------- VISTA 4: SALUD TÉCNICA Y BLOQUEOS ---------------- */
function renderSalud(emp, m) {
  const inf = emp.infraestructura;
  const bloqFiltrados = emp.bloqueos.filter((b) => {
    if (state.filtroBloqueo === 'abiertos') return !b.resuelto;
    if (state.filtroBloqueo === 'resueltos') return b.resuelto;
    return true;
  });

  return `
    ${renderConsultorRibbon(emp)}

    <section class="card">
      <div class="card-head">
        <div>
          <h2>Salud Técnica e Infraestructura</h2>
          <p>Estado real del servidor, base de datos, copias de seguridad e integraciones de <strong>${esc(emp.nombre)}</strong>.</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${(!state.exclusivoCliente && state.servidorVivo) ? `<button type="button" class="btn sm" id="btnSyncInline">🔌 Sincronizar con servidor GesPro</button>` : ''}
          <span class="live-badge"><span class="dot"></span>${esc(inf.estado)} · ${inf.latenciaMs} ms</span>
        </div>
      </div>

      <div class="health-grid">
        <div class="health-item">
          <div class="h-lbl">Disponibilidad (30d)</div>
          <div class="h-val num" style="color:var(--ok)">${inf.uptime}%</div>
          <div class="h-sub">${esc(inf.servidor)}</div>
        </div>
        <div class="health-item">
          <div class="h-lbl">Motor y Versión</div>
          <div class="h-val">${esc(inf.motor)}</div>
          <div class="h-sub">GesPro Administrativo <strong class="mono">${esc(inf.version)}</strong></div>
        </div>
        <div class="health-item">
          <div class="h-lbl">Último Respaldo Cifrado</div>
          <div class="h-val" style="font-size:14.5px">${esc(inf.ultimoRespaldo)}</div>
          <div class="h-sub">Rotación automática activa</div>
        </div>
        <div class="health-item">
          <div class="h-lbl">Ambiente de Pruebas (-TEST)</div>
          <div class="h-val" style="font-size:14.5px">${esc(inf.ambienteTest)}</div>
          <div class="h-sub">Gemela aislada para prácticas</div>
        </div>
        <div class="health-item">
          <div class="h-lbl">Puente SENIAT (RIF)</div>
          <div class="h-val" style="font-size:14.5px;color:${/sin contacto|pendiente/i.test(inf.puenteSeniat) ? 'var(--warn)' : 'var(--ok)'}">${esc(inf.puenteSeniat)}</div>
          <div class="h-sub">Consulta oficial de contribuyentes</div>
        </div>
        <div class="health-item">
          <div class="h-lbl">Tasa BCV Automática</div>
          <div class="h-val" style="font-size:14.5px">${esc(inf.tasaBcv)}</div>
          <div class="h-sub">Moneda base: ${esc(emp.monedaBase)}</div>
        </div>
        <div class="health-item">
          <div class="h-lbl">Seguridad · 2FA Activo</div>
          <div class="h-val num">${inf.adopcion2fa}%</div>
          <div class="prog-bar sm ${inf.adopcion2fa >= 80 ? 'ok' : 'warn'}" style="margin-top:6px"><div style="width:${inf.adopcion2fa}%"></div></div>
        </div>
        <div class="health-item">
          <div class="h-lbl">Volumen Acumulado en BD</div>
          <div class="h-val num" style="font-size:15px">${fmtNum(inf.documentosTotal)} docs</div>
          <div class="h-sub num">${fmtNum(inf.tercerosTotal)} terceros · ${fmtNum(inf.articulosTotal)} art. · ${fmtNum(inf.asientosTotal)} asientos</div>
        </div>
      </div>
    </section>

    <section class="grid-2-wide">
      <div class="card">
        <div class="card-head">
          <div>
            <h2>Bloqueos, Riesgos y Acuerdos</h2>
            <p>Seguimiento transparente de pendientes tanto del cliente como del equipo GesPro.</p>
          </div>
          ${(!state.exclusivoCliente && !state.accesoUsuarios) ? `<button type="button" class="btn sm primary" data-action="nuevo-bloqueo">+ Registrar bloqueo</button>` : ''}
        </div>

        <div class="filter-bar">
          <div class="filter-group">
            <button type="button" class="chip ${state.filtroBloqueo === 'abiertos' ? 'active' : ''}" data-filter-bloq="abiertos">Abiertos (${m.bloqueosAbiertos.length})</button>
            <button type="button" class="chip ${state.filtroBloqueo === 'resueltos' ? 'active' : ''}" data-filter-bloq="resueltos">Resueltos (${emp.bloqueos.length - m.bloqueosAbiertos.length})</button>
            <button type="button" class="chip ${state.filtroBloqueo === 'todos' ? 'active' : ''}" data-filter-bloq="todos">Todos (${emp.bloqueos.length})</button>
          </div>
        </div>

        <div class="blocker-list">
          ${bloqFiltrados.map((b) => `
            <div class="blocker-card prio-${b.prioridad} ${b.resuelto ? 'resolved' : ''}">
              <div style="flex:1;min-width:220px">
                <h4>${b.resuelto ? '✓ ' : ''}${esc(b.titulo)}</h4>
                <p>${esc(b.descripcion)}</p>
                <div class="blocker-tags">
                  <span class="pill ${b.resuelto ? 'ok' : b.prioridad === 'alta' ? 'danger' : b.prioridad === 'media' ? 'warn' : 'info'}">${b.resuelto ? 'Resuelto' : `Prioridad ${b.prioridad}`}</span>
                  <span class="pill neutral">Responsable: ${esc(b.responsable)}</span>
                  <span class="pill neutral">Fase: ${esc(b.fase)}</span>
                  <span class="pill neutral">Fecha límite: ${fmtFecha(b.fechaLimite)}</span>
                </div>
              </div>
              ${(!state.exclusivoCliente && !state.accesoUsuarios) ? `
              <button type="button" class="btn sm ${b.resuelto ? '' : 'ok'}" data-toggle-bloq="${b.id}">
                ${b.resuelto ? '↺ Reabrir' : '✓ Marcar resuelto'}
              </button>` : ''}
            </div>
          `).join('') || `<div class="empty-box">No hay registros en esta vista.</div>`}
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <h2>Bitácora de Seguimiento</h2>
            <p>Hitos, sesiones de entrenamiento y revisiones ejecutivas.</p>
          </div>
          ${(!state.exclusivoCliente && !state.accesoUsuarios) ? `<button type="button" class="btn sm" data-action="nueva-nota">+ Agregar nota</button>` : ''}
        </div>

        <div class="timeline">
          ${emp.bitacora.map((ev) => `
            <div class="tl-item">
              <span class="tl-dot ${ev.tipo || 'info'}"></span>
              <div class="tl-head">
                <span class="tl-date">${fmtFecha(ev.fecha)}</span>
                <span class="tl-title">${esc(ev.titulo)}</span>
              </div>
              <div class="tl-desc">${esc(ev.detalle)}</div>
            </div>
          `).join('') || `<div class="empty-box">Sin eventos en la bitácora todavía.</div>`}
        </div>
      </div>
    </section>
  `;
}

/* ---------------- VISTA 5: PORTAFOLIO MULTI-EMPRESA ---------------- */
function renderPortafolio(actual) {
  const todas = state.data.empresas.map((e) => ({ emp: e, m: calcEmpresa(e) }));
  const promImpl = Math.round(todas.reduce((a, x) => a + x.m.avanceImpl, 0) / Math.max(todas.length, 1));
  const conAlertas = todas.filter((x) => x.m.estadoGeneral.clase === 'danger').length;
  const totalUsrAct = todas.reduce((a, x) => a + x.m.usuariosActivos, 0);
  const totalDocsMes = todas.reduce((a, x) => a + x.m.docs30d, 0);

  const q = state.busquedaPortafolio.trim().toLowerCase();
  const filtradas = todas.filter(({ emp, m }) => {
    const okQ = !q || emp.nombre.toLowerCase().includes(q) || emp.codigo.toLowerCase().includes(q) || emp.rif.toLowerCase().includes(q) || emp.sector.toLowerCase().includes(q);
    if (!okQ) return false;
    if (state.filtroPortafolio === 'estables') return m.estadoGeneral.clase === 'ok';
    if (state.filtroPortafolio === 'implementacion') return m.avanceImpl < 90;
    if (state.filtroPortafolio === 'alertas') return m.estadoGeneral.clase === 'danger';
    return true;
  });

  return `
    ${renderDemoBanner()}
    <section class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-top"><span class="kpi-label">Empresas en Seguimiento</span><span class="kpi-ico">🏢</span></div>
        <div class="kpi-value num">${todas.length}</div>
        <div class="kpi-foot"><span>Portafolio GesPro</span><button type="button" class="btn xs primary" data-action="nueva-empresa">+ Nueva</button></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-top"><span class="kpi-label">Avance Promedio</span><span class="kpi-ico">🗺️</span></div>
        <div class="kpi-value num">${promImpl}%</div>
        <div class="prog-bar sm ok"><div style="width:${promImpl}%"></div></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-top"><span class="kpi-label">Empresas con Alertas</span><span class="kpi-ico">🚨</span></div>
        <div class="kpi-value num" style="color:${conAlertas ? 'var(--danger)' : 'var(--ok)'}">${conAlertas}</div>
        <div class="kpi-foot"><span>Bloqueos altos o subuso</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-top"><span class="kpi-label">Adopción Total Portafolio</span><span class="kpi-ico">⚡</span></div>
        <div class="kpi-value num">${fmtNum(totalDocsMes)} <span style="font-size:13px;color:var(--muted);font-weight:600">ops/30d</span></div>
        <div class="kpi-foot"><span>${totalUsrAct} usuarios activos esta semana</span></div>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <div>
          <h2>Cartera de Clientes en Implementación y Operación</h2>
          <p>Selecciona cualquier empresa para abrir su tablero interactivo detallado.</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="search" id="portfolioSearch" value="${esc(state.busquedaPortafolio)}" placeholder="Buscar por empresa, RIF o código..."
            style="padding:8px 12px;border-radius:9px;border:1px solid var(--line-strong);background:var(--surface-2);color:var(--ink);font:500 13px var(--font);min-width:270px">
          <button type="button" class="btn sm primary" data-action="nueva-empresa">+ Nueva Empresa</button>
        </div>
      </div>

      <div class="filter-bar">
        <div class="filter-group">
          <button type="button" class="chip ${state.filtroPortafolio === 'todas' ? 'active' : ''}" data-filter-port="todas">Todas (${todas.length})</button>
          <button type="button" class="chip ${state.filtroPortafolio === 'estables' ? 'active' : ''}" data-filter-port="estables">Producción estable</button>
          <button type="button" class="chip ${state.filtroPortafolio === 'implementacion' ? 'active' : ''}" data-filter-port="implementacion">En implementación</button>
          <button type="button" class="chip ${state.filtroPortafolio === 'alertas' ? 'active' : ''}" data-filter-port="alertas">Con alertas (${conAlertas})</button>
        </div>
      </div>

      <div class="portfolio-grid">
        ${filtradas.map(({ emp, m }) => `
          <div class="company-card ${emp.id === actual.id ? 'current' : ''}" data-pick-company="${esc(emp.id)}" role="button" tabindex="0">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
              <div>
                <div style="font-size:11.5px;font-weight:700;color:var(--brand);white-space:nowrap" class="mono">${esc(emp.codigo)} · ${esc(emp.rif)}</div>
                <h3 style="margin:3px 0 2px;font-size:16.5px;color:var(--ink)">${esc(emp.nombre)}</h3>
                <div style="font-size:12.5px;color:var(--muted)">${esc(emp.sector)}</div>
              </div>
              <span class="pill ${m.estadoGeneral.clase}">${esc(m.estadoGeneral.texto)}</span>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:10px 12px;background:var(--surface-2);border-radius:10px;border:1px solid var(--line)">
              <div>
                <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
                  <span style="color:var(--muted)">Implementación</span>
                  <strong class="num">${m.avanceImpl}%</strong>
                </div>
                <div class="prog-bar sm"><div style="width:${m.avanceImpl}%"></div></div>
              </div>
              <div>
                <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
                  <span style="color:var(--muted)">Uso real</span>
                  <strong class="num">${m.indiceUso}%</strong>
                </div>
                <div class="prog-bar sm ${m.semaforoUso.clase}"><div style="width:${m.indiceUso}%"></div></div>
              </div>
            </div>

            <div style="display:flex;justify-content:space-between;align-items:center;font-size:12.5px;color:var(--muted);flex-wrap:wrap;gap:6px">
              <span>📍 Fase ${m.faseActual.numero}: <strong style="color:var(--ink)">${esc(m.faseActual.corto)}</strong></span>
              <span class="num">👥 ${m.usuariosActivos}/${m.usuariosTotal} · 🚦 ${m.bloqueosAbiertos.length} bloq.</span>
            </div>
          </div>
        `).join('') || `<div class="empty-box">No se encontraron empresas con ese criterio.</div>`}
      </div>
    </section>
  `;
}

/* ---------------- MODALES INTERACTIVOS ---------------- */
function abrirModal({ titulo, subtitulo = '', cuerpo = '', pie = '' }) {
  document.getElementById('modalTitle').textContent = titulo;
  document.getElementById('modalSub').textContent = subtitulo;
  document.getElementById('modalBody').innerHTML = cuerpo;
  document.getElementById('modalFoot').innerHTML = pie;
  document.getElementById('modalBackdrop').hidden = false;
}

function cerrarModal() {
  document.getElementById('modalBackdrop').hidden = true;
}

function abrirModalModulo(emp, modId) {
  const mod = emp.modulos.find((x) => x.id === modId);
  if (!mod) return;
  const meta = moduloMeta(modId);
  const isCons = state.modo === 'consultor';

  const cuerpo = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-radius:12px;background:var(--surface-2);border:1px solid var(--line)">
      <div>
        <div style="font-size:12px;color:var(--muted);font-weight:700;text-transform:uppercase">${esc(meta.categoria)}</div>
        <div style="font-size:15px;font-weight:700;margin-top:2px">Recurso sugerido en Academia GesPro</div>
        <div style="font-size:13px;color:var(--ink-2)">${esc(meta.academia)}</div>
      </div>
      <a href="${ACADEMIA_URL}" target="_blank" rel="noopener" class="btn sm primary">🎓 Ir a Academia ↗</a>
    </div>

    ${isCons ? `
      <form id="formModulo" style="display:flex;flex-direction:column;gap:12px">
        <div class="field-row">
          <div class="field">
            <label>Estado de uso</label>
            <select name="estado">
              <option value="activo" ${mod.estado === 'activo' ? 'selected' : ''}>En uso activo</option>
              <option value="parcial" ${mod.estado === 'parcial' ? 'selected' : ''}>Uso parcial / transición</option>
              <option value="sin_uso" ${mod.estado === 'sin_uso' ? 'selected' : ''}>Sin uso (Alerta)</option>
              <option value="pendiente" ${mod.estado === 'pendiente' ? 'selected' : ''}>No iniciado / Fase posterior</option>
            </select>
          </div>
          <div class="field">
            <label>Nivel de adopción (%)</label>
            <input type="number" name="adopcion" min="0" max="100" value="${mod.adopcion}">
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Operaciones últimos 30 días</label>
            <input type="number" name="docs30d" min="0" value="${mod.docs30d}">
          </div>
          <div class="field">
            <label>Tendencia semanal (%)</label>
            <input type="number" name="tendencia" min="-100" max="500" value="${mod.tendencia}">
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Usuarios activos</label>
            <input type="number" name="usuariosActivos" min="0" value="${mod.usuariosActivos}">
          </div>
          <div class="field">
            <label>Usuarios asignados</label>
            <input type="number" name="usuariosAsignados" min="0" value="${mod.usuariosAsignados}">
          </div>
        </div>
        <div class="field">
          <label>Último uso registrado</label>
          <input type="text" name="ultimoUso" value="${esc(mod.ultimoUso)}">
        </div>
        <div class="field">
          <label>Diagnóstico y observaciones</label>
          <textarea name="nota" rows="3">${esc(mod.nota)}</textarea>
        </div>
      </form>
    ` : `
      <div class="health-grid" style="grid-template-columns:repeat(3,1fr)">
        <div class="health-item"><div class="h-lbl">Adopción</div><div class="h-val num">${mod.adopcion}%</div></div>
        <div class="health-item"><div class="h-lbl">Ops. 30 días</div><div class="h-val num">${fmtNum(mod.docs30d)}</div></div>
        <div class="health-item"><div class="h-lbl">Usuarios</div><div class="h-val num">${mod.usuariosActivos}/${mod.usuariosAsignados}</div></div>
      </div>
      <div class="health-item">
        <div class="h-lbl">Última actividad · Diagnóstico</div>
        <div style="font-weight:700;margin:4px 0">${esc(mod.ultimoUso)}</div>
        <div style="font-size:13.5px;color:var(--ink-2)">${esc(mod.nota)}</div>
      </div>
    `}
  `;

  const pie = isCons
    ? `<button type="button" class="btn" id="mCancel">Cancelar</button><button type="button" class="btn primary" id="mSaveMod">Guardar cambios</button>`
    : `${(!state.exclusivoCliente && !state.accesoUsuarios) ? `<button type="button" class="btn" id="mSwitchCons">⚙ Editar en Modo Consultor</button>` : ''}<button type="button" class="btn primary" id="mCancel">Cerrar</button>`;

  abrirModal({ titulo: `${meta.icono} ${meta.nombre}`, subtitulo: emp.nombre, cuerpo, pie });

  document.getElementById('mCancel')?.addEventListener('click', cerrarModal);
  document.getElementById('mSwitchCons')?.addEventListener('click', () => {
    state.modo = 'consultor';
    cerrarModal();
    render();
    abrirModalModulo(emp, modId);
  });
  document.getElementById('mSaveMod')?.addEventListener('click', () => {
    const fd = new FormData(document.getElementById('formModulo'));
    mod.estado = fd.get('estado');
    mod.adopcion = Math.max(0, Math.min(100, Number(fd.get('adopcion') || 0)));
    mod.docs30d = Math.max(0, Number(fd.get('docs30d') || 0));
    mod.tendencia = Number(fd.get('tendencia') || 0);
    mod.usuariosActivos = Math.max(0, Number(fd.get('usuariosActivos') || 0));
    mod.usuariosAsignados = Math.max(0, Number(fd.get('usuariosAsignados') || 0));
    mod.ultimoUso = String(fd.get('ultimoUso') || '').trim() || 'Hoy';
    mod.nota = String(fd.get('nota') || '').trim();
    guardarDatos();
    cerrarModal();
    render();
    toast(`Módulo ${meta.nombre} actualizado`);
  });
}

function abrirModalNuevaTarea(emp, faseId) {
  const fase = emp.fases.find((f) => f.id === faseId);
  if (!fase) return;
  abrirModal({
    titulo: `Nueva tarea en Fase ${fase.numero}`,
    subtitulo: fase.nombre,
    cuerpo: `
      <form id="formTarea" style="display:flex;flex-direction:column;gap:12px">
        <div class="field">
          <label>Descripción de la actividad / entregable *</label>
          <input type="text" name="titulo" required placeholder="Ej. Validar formato de factura fiscal impresa">
        </div>
        <div class="field-row">
          <div class="field">
            <label>Responsable</label>
            <select name="responsable">
              <option value="Ambos">Ambos (Cliente + GesPro)</option>
              <option value="Cliente">Cliente</option>
              <option value="GesPro">GesPro</option>
            </select>
          </div>
          <div class="field">
            <label>Fecha compromiso</label>
            <input type="date" name="fechaCompromiso" value="${esc(fase.fechaFin)}">
          </div>
        </div>
        <div class="field">
          <label>Notas o evidencia</label>
          <textarea name="nota" rows="2" placeholder="Detalles opcionales..."></textarea>
        </div>
      </form>
    `,
    pie: `<button type="button" class="btn" id="mCancel">Cancelar</button><button type="button" class="btn primary" id="mSave">Agregar tarea</button>`,
  });
  document.getElementById('mCancel').onclick = cerrarModal;
  document.getElementById('mSave').onclick = () => {
    const fd = new FormData(document.getElementById('formTarea'));
    const titulo = String(fd.get('titulo') || '').trim();
    if (!titulo) return toast('Escribe el título de la tarea');
    fase.tareas.push({
      id: `${fase.id}-t${Date.now()}`,
      titulo,
      responsable: fd.get('responsable') || 'Ambos',
      estado: 'pendiente',
      fechaCompromiso: fd.get('fechaCompromiso') || fase.fechaFin,
      nota: String(fd.get('nota') || '').trim(),
    });
    guardarDatos();
    cerrarModal();
    render();
    toast('Tarea agregada al flujo');
  };
}

function abrirModalNuevoBloqueo(emp) {
  abrirModal({
    titulo: 'Registrar bloqueo o compromiso',
    subtitulo: emp.nombre,
    cuerpo: `
      <form id="formBloq" style="display:flex;flex-direction:column;gap:12px">
        <div class="field">
          <label>Título del bloqueo o acuerdo *</label>
          <input type="text" name="titulo" required placeholder="Ej. Entrega de saldos iniciales de bancos">
        </div>
        <div class="field">
          <label>Detalle e impacto</label>
          <textarea name="descripcion" rows="3" placeholder="Explica qué falta y cómo afecta el avance..."></textarea>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Responsable</label>
            <select name="responsable">
              <option value="Cliente">Cliente</option>
              <option value="GesPro">GesPro</option>
              <option value="Ambos">Ambos</option>
            </select>
          </div>
          <div class="field">
            <label>Prioridad</label>
            <select name="prioridad">
              <option value="alta">Alta (frena el Go-Live)</option>
              <option value="media" selected>Media</option>
              <option value="baja">Baja</option>
            </select>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Fase afectada</label>
            <select name="fase">
              ${emp.fases.map((f) => `<option value="${esc(f.corto)}">${esc(f.nombre)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Fecha límite</label>
            <input type="date" name="fechaLimite" value="${new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10)}">
          </div>
        </div>
      </form>
    `,
    pie: `<button type="button" class="btn" id="mCancel">Cancelar</button><button type="button" class="btn primary" id="mSave">Guardar registro</button>`,
  });
  document.getElementById('mCancel').onclick = cerrarModal;
  document.getElementById('mSave').onclick = () => {
    const fd = new FormData(document.getElementById('formBloq'));
    const titulo = String(fd.get('titulo') || '').trim();
    if (!titulo) return toast('Indica el título del bloqueo');
    emp.bloqueos.unshift({
      id: `b-${Date.now()}`,
      titulo,
      descripcion: String(fd.get('descripcion') || '').trim() || 'Seguimiento activo del proyecto.',
      responsable: fd.get('responsable') || 'Cliente',
      prioridad: fd.get('prioridad') || 'media',
      fase: fd.get('fase') || 'Configuración',
      fechaLimite: fd.get('fechaLimite') || new Date().toISOString().slice(0, 10),
      resuelto: false,
    });
    emp.bitacora.unshift({
      fecha: new Date().toISOString().slice(0, 10),
      tipo: fd.get('prioridad') === 'alta' ? 'danger' : 'warn',
      titulo: `Bloqueo registrado: ${titulo}`,
      detalle: `Asignado a ${fd.get('responsable')} · Meta ${fd.get('fechaLimite')}.`,
    });
    guardarDatos();
    cerrarModal();
    render();
    toast('Bloqueo registrado en seguimiento');
  };
}

function abrirModalNuevaNota(emp) {
  abrirModal({
    titulo: 'Agregar nota a la bitácora',
    subtitulo: emp.nombre,
    cuerpo: `
      <form id="formNota" style="display:flex;flex-direction:column;gap:12px">
        <div class="field-row">
          <div class="field">
            <label>Fecha</label>
            <input type="date" name="fecha" value="${new Date().toISOString().slice(0, 10)}">
          </div>
          <div class="field">
            <label>Tipo de hito</label>
            <select name="tipo">
              <option value="ok">Avance / Logro</option>
              <option value="info" selected>Reunión / Seguimiento</option>
              <option value="warn">Advertencia / Riesgo</option>
              <option value="danger">Alerta crítica</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>Título *</label>
          <input type="text" name="titulo" required placeholder="Ej. Revisión semanal con Gerencia Administrativa">
        </div>
        <div class="field">
          <label>Resumen de acuerdos</label>
          <textarea name="detalle" rows="3" placeholder="Qué se validó y cuál es el próximo paso..."></textarea>
        </div>
      </form>
    `,
    pie: `<button type="button" class="btn" id="mCancel">Cancelar</button><button type="button" class="btn primary" id="mSave">Publicar en bitácora</button>`,
  });
  document.getElementById('mCancel').onclick = cerrarModal;
  document.getElementById('mSave').onclick = () => {
    const fd = new FormData(document.getElementById('formNota'));
    const titulo = String(fd.get('titulo') || '').trim();
    if (!titulo) return toast('Escribe un título');
    emp.bitacora.unshift({
      fecha: fd.get('fecha') || new Date().toISOString().slice(0, 10),
      tipo: fd.get('tipo') || 'info',
      titulo,
      detalle: String(fd.get('detalle') || '').trim() || 'Actualización registrada desde GesPro Pulse.',
    });
    guardarDatos();
    cerrarModal();
    render();
    toast('Nota agregada a la bitácora');
  };
}

function abrirModalNuevoUsuario(emp) {
  abrirModal({
    titulo: 'Agregar usuario clave a seguimiento',
    subtitulo: emp.nombre,
    cuerpo: `
      <form id="formUsr" style="display:flex;flex-direction:column;gap:12px">
        <div class="field-row">
          <div class="field"><label>Nombre completo *</label><input type="text" name="nombre" required placeholder="Ej. Laura Gómez"></div>
          <div class="field"><label>Área / Departamento</label><input type="text" name="area" placeholder="Ej. Facturación y Cobranza"></div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Rol en GesPro</label>
            <select name="rol">
              <option value="admin">admin</option>
              <option value="ventas">ventas</option>
              <option value="vendedor">vendedor</option>
              <option value="cajero">cajero</option>
              <option value="compras">compras</option>
              <option value="tesoreria">tesoreria</option>
              <option value="almacen">almacen</option>
              <option value="contabilidad">contabilidad</option>
              <option value="consulta">consulta</option>
            </select>
          </div>
          <div class="field">
            <label>Estado de adopción</label>
            <select name="estado">
              <option value="campeon">Campeón</option>
              <option value="activo" selected>Activo</option>
              <option value="refuerzo">Requiere refuerzo</option>
              <option value="inactivo">Inactivo</option>
            </select>
          </div>
        </div>
        <div class="field-row">
          <div class="field"><label>Sesiones / semana</label><input type="number" name="sesionesSemana" min="0" value="8"></div>
          <div class="field"><label>Avance Academia (%)</label><input type="number" name="academiaPct" min="0" max="100" value="50"></div>
        </div>
      </form>
    `,
    pie: `<button type="button" class="btn" id="mCancel">Cancelar</button><button type="button" class="btn primary" id="mSave">Agregar usuario</button>`,
  });
  document.getElementById('mCancel').onclick = cerrarModal;
  document.getElementById('mSave').onclick = () => {
    const fd = new FormData(document.getElementById('formUsr'));
    const nombre = String(fd.get('nombre') || '').trim();
    if (!nombre) return toast('Ingresa el nombre del usuario');
    emp.usuarios.push({
      nombre,
      area: String(fd.get('area') || 'Operaciones').trim(),
      rol: fd.get('rol') || 'ventas',
      sesionesSemana: Number(fd.get('sesionesSemana') || 0),
      operaciones30d: Number(fd.get('sesionesSemana') || 0) * 12,
      academiaPct: Math.max(0, Math.min(100, Number(fd.get('academiaPct') || 0))),
      ultimoAcceso: 'Hoy',
      estado: fd.get('estado') || 'activo',
    });
    guardarDatos();
    cerrarModal();
    render();
    toast('Usuario agregado al monitor de adopción');
  };
}

function abrirModalNuevaEmpresa() {
  const nextNum = String(state.data.empresas.length + 1).padStart(3, '0');
  const defaultGoLive = new Date(Date.now() + 42 * 86400000).toISOString().slice(0, 10);
  abrirModal({
    titulo: 'Dar de alta nueva empresa en implementación',
    subtitulo: 'Se cargará automáticamente el flujo oficial de 6 fases y los 12 módulos de GesPro Administrativo.',
    cuerpo: `
      <form id="formEmp" style="display:flex;flex-direction:column;gap:12px">
        <div class="field-row">
          <div class="field"><label>Código *</label><input type="text" name="codigo" required value="EMP-${nextNum}"></div>
          <div class="field"><label>RIF</label><input type="text" name="rif" placeholder="J-00000000-0"></div>
        </div>
        <div class="field"><label>Razón social de la empresa *</label><input type="text" name="nombre" required placeholder="Ej. Ferretería Industrial del Norte, C.A."></div>
        <div class="field-row">
          <div class="field"><label>Sector / Giro</label><input type="text" name="sector" placeholder="Ej. Distribución y Retail"></div>
          <div class="field">
            <label>Modalidad de despliegue</label>
            <select name="plan">
              <option value="Corporativo Nube · PostgreSQL">Corporativo Nube · PostgreSQL</option>
              <option value="Enterprise Nube · PostgreSQL">Enterprise Nube · PostgreSQL</option>
              <option value="Servidor Local Oficina · Windows Server">Servidor Local Oficina · Windows Server</option>
              <option value="Instalación Escritorio · SQLite WAL">Instalación Escritorio · SQLite WAL</option>
            </select>
          </div>
        </div>
        <div class="field-row">
          <div class="field"><label>Consultor GesPro</label><input type="text" name="consultor" value="Ing. José Rodríguez"></div>
          <div class="field"><label>Sponsor / Gerente Cliente</label><input type="text" name="sponsorCliente" placeholder="Ej. Lic. María Fernanda Ruiz"></div>
        </div>
        <div class="field"><label>Fecha estimada de Salida en Vivo (Go-Live)</label><input type="date" name="fechaGoLive" value="${defaultGoLive}"></div>
      </form>
    `,
    pie: `<button type="button" class="btn" id="mCancel">Cancelar</button><button type="button" class="btn primary" id="mSave">Crear empresa</button>`,
  });
  document.getElementById('mCancel').onclick = cerrarModal;
  document.getElementById('mSave').onclick = () => {
    const fd = new FormData(document.getElementById('formEmp'));
    const nombre = String(fd.get('nombre') || '').trim();
    const codigo = String(fd.get('codigo') || `EMP-${nextNum}`).trim().toUpperCase();
    if (!nombre) return toast('Indica el nombre de la empresa');
    if (state.data.empresas.some((e) => e.id === codigo)) return toast(`El código ${codigo} ya existe`);
    const nueva = crearEmpresaNueva({
      codigo,
      nombre,
      rif: String(fd.get('rif') || '').trim(),
      sector: String(fd.get('sector') || '').trim(),
      plan: fd.get('plan'),
      consultor: String(fd.get('consultor') || '').trim(),
      sponsorCliente: String(fd.get('sponsorCliente') || '').trim(),
      fechaGoLive: fd.get('fechaGoLive'),
    });
    state.data.empresas.unshift(nueva);
    state.empresaId = nueva.id;
    state.tab = 'resumen';
    state.faseSeleccionadaResumen = 'f1';
    guardarDatos();
    cerrarModal();
    render();
    toast(`Empresa ${nombre} creada con flujo de 6 fases`);
  };
}

function abrirModalEditarEmpresa(emp) {
  abrirModal({
    titulo: `Editar ficha ejecutiva · ${emp.codigo}`,
    subtitulo: emp.nombre,
    cuerpo: `
      <form id="formEditEmp" style="display:flex;flex-direction:column;gap:12px">
        <div class="field"><label>Nombre de la empresa</label><input type="text" name="nombre" value="${esc(emp.nombre)}"></div>
        <div class="field-row">
          <div class="field"><label>Consultor asignado</label><input type="text" name="consultor" value="${esc(emp.consultor)}"></div>
          <div class="field"><label>Sponsor cliente</label><input type="text" name="sponsorCliente" value="${esc(emp.sponsorCliente)}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Fecha Go-Live meta</label><input type="date" name="fechaGoLive" value="${esc(emp.fechaGoLive)}"></div>
          <div class="field"><label>Plan / Entorno</label><input type="text" name="plan" value="${esc(emp.plan)}"></div>
        </div>
        <div class="field">
          <label>Resumen ejecutivo visible al cliente</label>
          <textarea name="resumenEjecutivo" rows="3">${esc(emp.resumenEjecutivo)}</textarea>
        </div>
      </form>
    `,
    pie: `<button type="button" class="btn" id="mCancel">Cancelar</button><button type="button" class="btn primary" id="mSave">Guardar ficha</button>`,
  });
  document.getElementById('mCancel').onclick = cerrarModal;
  document.getElementById('mSave').onclick = () => {
    const fd = new FormData(document.getElementById('formEditEmp'));
    emp.nombre = String(fd.get('nombre') || emp.nombre).trim();
    emp.consultor = String(fd.get('consultor') || emp.consultor).trim();
    emp.sponsorCliente = String(fd.get('sponsorCliente') || emp.sponsorCliente).trim();
    emp.fechaGoLive = fd.get('fechaGoLive') || emp.fechaGoLive;
    emp.plan = String(fd.get('plan') || emp.plan).trim();
    emp.resumenEjecutivo = String(fd.get('resumenEjecutivo') || emp.resumenEjecutivo).trim();
    guardarDatos();
    cerrarModal();
    render();
    toast('Ficha ejecutiva actualizada');
  };
}

async function abrirModalCompartir(emp) {
  const esHostLocal = /^(127\.0\.0\.1|localhost)$/i.test(window.location.hostname) || window.location.protocol === 'file:';
  const guardada = localStorage.getItem(PUBLIC_BASE_URL_KEY) || '';
  const baseGuardadaLimpia = guardada && !/github\.io/i.test(guardada) ? guardada : DEFAULT_PUBLIC_BASE;
  const basePublica = esHostLocal
    ? baseGuardadaLimpia
    : `${window.location.origin}${window.location.pathname}`;
  const baseLimpia = basePublica.replace(/\/+$/, '') + '/';

  const tokenCliente = await codificarSnapshotCliente(emp);
  const linkPrivadoEmpresa = `${baseLimpia}#cliente=${tokenCliente}`;
  const linkAccesoVivo = !esHostLocal && state.servidorVivo ? `${window.location.origin}/?acceso=1` : null;

  abrirModal({
    titulo: 'Compartir con usuarios y clientes de GesPro',
    subtitulo: emp.nombre,
    cuerpo: `
      ${linkAccesoVivo ? `
        <div style="padding:12px 14px;border-radius:12px;background:var(--ok-bg);border:1px solid var(--ok-line);display:flex;flex-direction:column;gap:8px">
          <div style="font-size:13px;font-weight:700;color:var(--ok)">⚡ Opción 1 · Enlace en vivo para usuarios de GesPro (con su clave)</div>
          <div style="font-size:12.5px;color:var(--ink-2)">Cada usuario entra con su usuario, contraseña y 2FA de GesPro y ve <strong>solo su empresa en tiempo real</strong>.</div>
          <div class="code-box" id="shareLiveBox">${esc(linkAccesoVivo)}</div>
          <div><button type="button" class="btn ok sm" id="mCopyLive">📋 Copiar enlace en vivo</button></div>
        </div>
      ` : ''}

      <div style="padding:12px 14px;border-radius:12px;background:var(--surface-2);border:1px solid var(--line);display:flex;flex-direction:column;gap:8px">
        <div style="font-size:13px;font-weight:700;color:var(--ink)">🔒 ${linkAccesoVivo ? 'Opción 2 · ' : ''}Enlace exclusivo de ${esc(emp.nombre)} (sin contraseña · 24/7)</div>
        <div style="font-size:12.5px;color:var(--ink-2)">Abre una vista aislada que muestra <strong>únicamente a esta empresa</strong> con los datos actuales (sin acceso a otros clientes ni botones de edición). Ideal para enviar por WhatsApp o correo.</div>
        <div class="field">
          <label>Dominio público base del enlace</label>
          <input type="url" id="shareBaseInput" value="${esc(baseLimpia)}">
        </div>
        <div class="code-box" id="shareUrlBox" style="max-height:92px;overflow-y:auto">${esc(linkPrivadoEmpresa)}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn primary sm" id="mCopyUrl">📋 Copiar enlace exclusivo</button>
          <a class="btn sm" id="mOpenPreview" href="${esc(linkPrivadoEmpresa)}" target="_blank" rel="noopener">↗ Abrir vista previa</a>
          <button type="button" class="btn sm" id="mPrintNow">⎙ Guardar PDF</button>
        </div>
      </div>
    `,
    pie: `<button type="button" class="btn" id="mCancel">Cerrar</button>`,
  });

  document.getElementById('mCancel').onclick = cerrarModal;

  const baseInput = document.getElementById('shareBaseInput');
  const box = document.getElementById('shareUrlBox');
  const openBtn = document.getElementById('mOpenPreview');
  let enlaceActual = linkPrivadoEmpresa;

  baseInput?.addEventListener('input', () => {
    const val = baseInput.value.trim();
    if (/^https?:\/\//i.test(val)) {
      const clean = val.replace(/\/+$/, '') + '/';
      try { localStorage.setItem(PUBLIC_BASE_URL_KEY, clean); } catch {}
      enlaceActual = `${clean}#cliente=${tokenCliente}`;
      box.textContent = enlaceActual;
      openBtn.href = enlaceActual;
    }
  });

  document.getElementById('mCopyLive')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(linkAccesoVivo); toast('Enlace en vivo copiado ✓'); }
    catch { toast('Copia el enlace manualmente'); }
  });
  document.getElementById('mCopyUrl')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(enlaceActual); toast('Enlace exclusivo de empresa copiado ✓'); }
    catch { toast('Copia manualmente el enlace de la caja'); }
  });
  document.getElementById('mPrintNow')?.addEventListener('click', () => { cerrarModal(); setTimeout(() => window.print(), 150); });
}

function construirFasesDesdeHints(hints = {}, fechaInicio, fechaGoLive) {
  const fIni = fechaInicio || new Date().toISOString().slice(0, 10);
  const fFin = fechaGoLive || fIni;
  return FASES_PLANTILLA.map((f) => {
    const arr = Array.isArray(hints[f.id]) ? hints[f.id] : [];
    return {
      id: f.id,
      numero: f.numero,
      nombre: f.nombre,
      corto: f.corto,
      descripcion: f.descripcion,
      semanaInicio: f.semanaInicio,
      semanaFin: f.semanaFin,
      fechaInicio: fIni,
      fechaFin: fFin,
      tareas: f.tareasBase.map((t, idx) => ({
        id: `${f.id}-t${idx + 1}`,
        titulo: t.titulo,
        responsable: t.responsable,
        estado: arr[idx] || 'pendiente',
        fechaCompromiso: fFin,
        nota: t.nota,
      })),
    };
  });
}

function abrirModalConectarServidor() {
  const urlGuardada = localStorage.getItem(SERVER_URL_KEY) || DEFAULT_GESPRO_URL;
  let tokenParcial2fa = null;

  abrirModal({
    titulo: 'Conectar con GesPro Administrativo (En vivo)',
    subtitulo: 'Lectura segura de tus empresas reales, usuarios, auditoría por módulo e infraestructura. No modifica ningún dato ni guarda contraseñas.',
    cuerpo: `
      <form id="formSync" style="display:flex;flex-direction:column;gap:12px">
        <div class="field">
          <label>URL de tu servidor GesPro Administrativo</label>
          <input type="url" name="url" id="syncUrl" value="${esc(urlGuardada)}" placeholder="https://gespro-administrativo.gespro.ai" required>
        </div>

        <div id="syncPaso1" style="display:flex;flex-direction:column;gap:12px">
          <div class="field-row">
            <div class="field"><label>Usuario (superadmin o admin)</label><input type="text" name="usuario" id="syncUsuario" placeholder="superadmin" autocomplete="username"></div>
            <div class="field"><label>Contraseña (solo para esta lectura)</label><input type="password" name="password" id="syncPassword" placeholder="••••••••" autocomplete="current-password"></div>
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--ink-2);cursor:pointer">
            <input type="checkbox" id="syncReemplazarDemo" checked>
            <span>Reemplazar empresas de demostración por mis empresas reales</span>
          </label>
        </div>

        <div id="syncPaso2" style="display:none;flex-direction:column;gap:10px;padding:13px;border-radius:11px;background:var(--info-bg);border:1px solid var(--info-line)">
          <div style="font-size:13px;font-weight:700;color:var(--ink)">🔐 Verificación en dos pasos (2FA) requerida</div>
          <div style="font-size:12.5px;color:var(--ink-2)" id="sync2faSub">Ingresa el código de 6 dígitos de tu app autenticadora (o un código de recuperación).</div>
          <div class="field">
            <label>Código 2FA</label>
            <input type="text" id="syncCodigo2fa" inputmode="numeric" placeholder="000000" autocomplete="one-time-code" style="font-family:var(--mono);font-size:16px;letter-spacing:3px">
          </div>
        </div>
      </form>
      <div id="syncMsg" style="font-size:13px;color:var(--muted)"></div>
    `,
    pie: `<button type="button" class="btn" id="mCancel">Cancelar</button><button type="button" class="btn ok" id="mRunSync">🔌 Conectar y cargar empresas reales</button>`,
  });

  document.getElementById('mCancel').onclick = cerrarModal;

  const ejecutar = async () => {
    const url = document.getElementById('syncUrl').value.trim();
    const usuario = document.getElementById('syncUsuario').value.trim();
    const password = document.getElementById('syncPassword').value;
    const reemplazarDemo = document.getElementById('syncReemplazarDemo').checked;
    const msg = document.getElementById('syncMsg');
    const btn = document.getElementById('mRunSync');

    let payload;
    if (tokenParcial2fa) {
      const codigo = document.getElementById('syncCodigo2fa').value.trim();
      if (!codigo) {
        msg.innerHTML = '<span style="color:var(--danger)">Escribe el código de 6 dígitos de tu autenticador.</span>';
        return;
      }
      payload = { url, token_parcial: tokenParcial2fa, codigo };
    } else {
      if (!url || !usuario || !password) {
        msg.innerHTML = '<span style="color:var(--danger)">Completa la URL, el usuario y la contraseña.</span>';
        return;
      }
      payload = { url, usuario, password };
    }

    btn.disabled = true;
    btn.textContent = '⏳ Leyendo empresas reales…';
    msg.textContent = 'Consultando empresas, usuarios, auditoría de uso e infraestructura en GesPro…';

    try {
      const res = await fetch('/api/sincronizar-gespro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await leerJsonSeguro(res);
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);

      if (json.requiere_2fa) {
        tokenParcial2fa = json.token_parcial;
        document.getElementById('syncPaso1').style.display = 'none';
        document.getElementById('syncPaso2').style.display = 'flex';
        document.getElementById('sync2faSub').textContent = `Cuenta: ${json.usuario?.nombre || usuario}. Ingresa el código de 6 dígitos de tu autenticador.`;
        msg.innerHTML = '<span style="color:var(--info)">Esperando código de verificación en dos pasos…</span>';
        btn.disabled = false;
        btn.textContent = '✓ Verificar y cargar empresas';
        document.getElementById('syncCodigo2fa').focus();
        return;
      }

      try { localStorage.setItem(SERVER_URL_KEY, json.origen || url); } catch {}

      const prevByCode = new Map(
        (reemplazarDemo ? state.data.empresas.filter((e) => e.origenReal) : state.data.empresas)
          .map((e) => [e.codigo, e]),
      );

      const nuevasLista = [];
      const codigosVistos = new Set();

      for (const remote of (json.empresas || [])) {
        codigosVistos.add(remote.codigo);
        const previa = prevByCode.get(remote.codigo);
        if (previa) {
          // Conserva fases, consultor y bloqueos manuales; refresca telemetría real
          const bloqManuales = (previa.bloqueos || []).filter((b) => !String(b.id).startsWith('auto-'));
          nuevasLista.push({
            ...previa,
            nombre: remote.nombre,
            rif: remote.rif,
            plan: remote.plan,
            monedaBase: remote.monedaBase,
            resumenEjecutivo: remote.resumenEjecutivo,
            origenReal: true,
            infraestructura: remote.infraestructura,
            actividadSemanal: remote.actividadSemanal,
            modulos: remote.modulos,
            usuarios: remote.usuarios,
            bloqueos: [...bloqManuales, ...remote.bloqueos],
            bitacora: [...remote.bitacora, ...(previa.bitacora || []).filter((ev) => ev.titulo !== 'Sincronización en vivo con servidor GesPro')].slice(0, 30),
          });
        } else {
          nuevasLista.push({
            ...remote,
            fases: construirFasesDesdeHints(remote.faseHints, remote.fechaInicio, remote.fechaGoLive),
          });
        }
      }

      if (!reemplazarDemo) {
        for (const e of state.data.empresas) {
          if (!codigosVistos.has(e.codigo)) nuevasLista.push(e);
        }
      }

      if (!nuevasLista.length) {
        throw new Error('Tu usuario no devolvió empresas activas en ese servidor.');
      }

      state.data.empresas = nuevasLista;
      state.data.fuenteReal = json.origen || url;
      state.empresaId = nuevasLista[0].id;
      state.faseSeleccionadaResumen = null;
      state.tab = 'portafolio';
      guardarDatos();
      cerrarModal();
      render();
      toast(`✓ ${nuevasLista.length} empresa(s) real(es) cargadas desde ${new URL(json.origen || url).hostname}`);
    } catch (err) {
      msg.innerHTML = `<span style="color:var(--danger)">${esc(mensajeErrorRed(err))}</span>`;
      btn.disabled = false;
      btn.textContent = tokenParcial2fa ? '✓ Verificar y cargar empresas' : '🔌 Conectar y cargar empresas reales';
    }
  };

  document.getElementById('mRunSync').onclick = ejecutar;
  document.getElementById('formSync').addEventListener('submit', (e) => { e.preventDefault(); ejecutar(); });
}

/* ---------------- Exportar / Importar JSON ---------------- */
function exportarJson() {
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gespro-pulse-seguimiento-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Respaldo JSON descargado');
}

/* ---------------- Tooltips de Gráficos SVG ---------------- */
function bindChartTooltips(emp) {
  document.querySelectorAll('.chart-hit').forEach((rect) => {
    const idx = Number(rect.dataset.idx);
    const chartId = rect.dataset.chart;
    const tip = document.getElementById(`${chartId}-tip`);
    const box = document.getElementById(chartId);
    const w = emp.actividadSemanal?.[idx];
    if (!tip || !box || !w) return;

    const show = (ev) => {
      const bRect = box.getBoundingClientRect();
      const left = Math.max(85, Math.min(bRect.width - 85, ev.clientX - bRect.left));
      const top = Math.max(60, ev.clientY - bRect.top);
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
      tip.innerHTML = `
        <div style="font-weight:800;margin-bottom:4px;color:#8cc8ff">${esc(w.sem)}</div>
        <div>Facturas/Pedidos: <strong>${fmtNum(w.facturas)}</strong></div>
        <div>Cobros/Pagos: <strong>${fmtNum(w.cobrosPagos)}</strong></div>
        <div>Inventario: <strong>${fmtNum(w.inventario)}</strong></div>
        <div>Asientos: <strong>${fmtNum(w.asientos)}</strong></div>
      `;
      tip.classList.add('show');
    };
    rect.addEventListener('mousemove', show);
    rect.addEventListener('mouseenter', show);
    rect.addEventListener('mouseleave', () => tip.classList.remove('show'));
  });
}

/* ---------------- Render Principal & Delegación de Eventos ---------------- */
function render() {
  renderChrome();
  const app = document.getElementById('app');

  if (state.accesoUsuarios && !state.autenticadoPortal) {
    app.innerHTML = renderPortalAcceso();
    bindPortalAccesoEvents();
    return;
  }

  const emp = empresaActual();
  if (!emp) return;
  const m = calcEmpresa(emp);

  if (state.tab === 'resumen') app.innerHTML = renderResumen(emp, m);
  else if (state.tab === 'flujo') app.innerHTML = renderFlujo(emp, m);
  else if (state.tab === 'uso') app.innerHTML = renderUso(emp, m);
  else if (state.tab === 'salud') app.innerHTML = renderSalud(emp, m);
  else if (state.tab === 'portafolio') app.innerHTML = renderPortafolio(emp);

  bindChartTooltips(emp);
  bindViewEvents(emp);
}

function bindViewEvents(emp) {
  const app = document.getElementById('app');

  app.querySelectorAll('[data-select-phase]').forEach((el) => {
    const pick = () => {
      state.faseSeleccionadaResumen = el.dataset.selectPhase;
      render();
    };
    el.addEventListener('click', pick);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  });

  app.querySelectorAll('[data-goto-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.gotoTab;
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  app.querySelectorAll('[data-toggle-task]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [faseId, taskId] = btn.dataset.toggleTask.split('|');
      const fase = emp.fases.find((f) => f.id === faseId);
      const task = fase?.tareas.find((t) => t.id === taskId);
      if (!task) return;
      task.estado = task.estado === 'completado' ? 'en_curso' : 'completado';
      guardarDatos();
      render();
      toast(task.estado === 'completado' ? 'Tarea marcada como completada ✓' : 'Tarea reabierta como En curso');
    });
  });

  app.querySelectorAll('[data-task-status]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const [faseId, taskId] = sel.dataset.taskStatus.split('|');
      const fase = emp.fases.find((f) => f.id === faseId);
      const task = fase?.tareas.find((t) => t.id === taskId);
      if (!task) return;
      task.estado = sel.value;
      guardarDatos();
      render();
      toast('Estado de tarea actualizado');
    });
  });

  app.querySelectorAll('[data-add-task]').forEach((btn) => {
    btn.addEventListener('click', () => abrirModalNuevaTarea(emp, btn.dataset.addTask));
  });

  app.querySelectorAll('[data-filter-flujo]').forEach((btn) => {
    btn.addEventListener('click', () => { state.filtroFlujo = btn.dataset.filterFlujo; render(); });
  });
  app.querySelectorAll('[data-filter-resp]').forEach((btn) => {
    btn.addEventListener('click', () => { state.filtroRespFlujo = btn.dataset.filterResp; render(); });
  });
  app.querySelectorAll('[data-filter-mod]').forEach((btn) => {
    btn.addEventListener('click', () => { state.filtroModCat = btn.dataset.filterMod; render(); });
  });
  app.querySelectorAll('[data-filter-bloq]').forEach((btn) => {
    btn.addEventListener('click', () => { state.filtroBloqueo = btn.dataset.filterBloq; render(); });
  });
  app.querySelectorAll('[data-filter-port]').forEach((btn) => {
    btn.addEventListener('click', () => { state.filtroPortafolio = btn.dataset.filterPort; render(); });
  });

  app.querySelectorAll('[data-toggle-series]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.toggleSeries;
      state.seriesActivas[k] = !state.seriesActivas[k];
      render();
    });
  });

  app.querySelectorAll('[data-open-module]').forEach((el) => {
    const open = () => abrirModalModulo(emp, el.dataset.openModule);
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });

  app.querySelectorAll('[data-toggle-bloq]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const b = emp.bloqueos.find((x) => x.id === btn.dataset.toggleBloq);
      if (!b) return;
      b.resuelto = !b.resuelto;
      emp.bitacora.unshift({
        fecha: new Date().toISOString().slice(0, 10),
        tipo: b.resuelto ? 'ok' : 'warn',
        titulo: b.resuelto ? `Bloqueo resuelto: ${b.titulo}` : `Bloqueo reabierto: ${b.titulo}`,
        detalle: `Actualizado en seguimiento de ${emp.nombre}.`,
      });
      guardarDatos();
      render();
      toast(b.resuelto ? 'Bloqueo marcado como resuelto ✓' : 'Bloqueo reabierto');
    });
  });

  app.querySelectorAll('[data-pick-company]').forEach((el) => {
    const pick = () => {
      state.empresaId = el.dataset.pickCompany;
      state.faseSeleccionadaResumen = null;
      state.tab = 'resumen';
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    el.addEventListener('click', pick);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  });

  app.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.action;
      if (act === 'nueva-empresa') abrirModalNuevaEmpresa();
      else if (act === 'editar-empresa') abrirModalEditarEmpresa(emp);
      else if (act === 'nuevo-bloqueo') abrirModalNuevoBloqueo(emp);
      else if (act === 'nueva-nota') abrirModalNuevaNota(emp);
      else if (act === 'nuevo-usuario') abrirModalNuevoUsuario(emp);
      else if (act === 'conectar-gespro') abrirModalConectarServidor();
    });
  });

  document.getElementById('btnSyncInline')?.addEventListener('click', abrirModalConectarServidor);

  const pSearch = document.getElementById('portfolioSearch');
  if (pSearch) {
    pSearch.addEventListener('input', (e) => {
      state.busquedaPortafolio = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const inp = document.getElementById('portfolioSearch');
      if (inp) { inp.focus(); inp.setSelectionRange(pos, pos); }
    });
  }
}

/* ---------------- Tema Claro / Oscuro ---------------- */
function aplicarTema(tema) {
  document.documentElement.setAttribute('data-theme', tema);
  document.getElementById('themeIcon').textContent = tema === 'dark' ? '☀️' : '🌙';
  try { localStorage.setItem(THEME_KEY, tema); } catch {}
}

/* ---------------- Arranque ---------------- */
async function init() {
  const params = new URLSearchParams(window.location.search);
  const hash = String(window.location.hash || '');

  // 1. Detectar si el servidor Node en vivo está presente (/api/modo-servidor)
  try {
    const r = await fetch('/api/modo-servidor', { cache: 'no-store' });
    if (r.ok) {
      const info = await r.json();
      if (info?.vivo) {
        state.servidorVivo = true;
        state.esLocal = !!info.esLocal;
      }
    }
  } catch {}

  // 2. Comprobar si viene un enlace exclusivo de cliente (#cliente=...)
  const matchCliente = hash.match(/^#cliente=([A-Za-z0-9._-]+)$/);
  if (matchCliente) {
    const snap = await decodificarSnapshotCliente(matchCliente[1]);
    if (snap?.emp) {
      state.exclusivoCliente = true;
      state.modo = 'cliente';
      state.data = {
        version: 1,
        actualizadoEn: snap.at || ahoraTexto(),
        fuenteReal: 'Enlace exclusivo',
        empresas: [snap.emp],
      };
      state.empresaId = snap.emp.id;
    }
  }

  // 3. Si es enlace público del servidor vivo (no localhost) o ?acceso=1 -> pantalla de login de usuarios GesPro
  if (!state.exclusivoCliente && state.servidorVivo && (params.get('acceso') === '1' || (!state.esLocal && params.get('demo') !== '1'))) {
    state.accesoUsuarios = true;
    state.modo = 'cliente';
  }

  // Leer parámetros URL (?empresa=EMP-002&vista=cliente&tab=uso)
  if (!state.exclusivoCliente && !state.accesoUsuarios) {
    const qEmp = params.get('empresa');
    const qVista = params.get('vista');
    const qTab = params.get('tab');

    if (qEmp && state.data.empresas.some((e) => e.id === qEmp)) state.empresaId = qEmp;
    else state.empresaId = state.data.empresas[0]?.id || null;

    if (qVista === 'consultor' || qVista === 'cliente') state.modo = qVista;
    if (['resumen', 'flujo', 'uso', 'salud', 'portafolio'].includes(qTab)) state.tab = qTab;
  }

  // Tema guardado
  const savedTheme = localStorage.getItem(THEME_KEY) || 'light';
  aplicarTema(savedTheme);

  // Eventos globales de barra superior
  document.getElementById('btnHome').addEventListener('click', (e) => {
    e.preventDefault();
    state.tab = 'resumen';
    render();
  });

  document.getElementById('companySelect').addEventListener('change', (e) => {
    state.empresaId = e.target.value;
    state.faseSeleccionadaResumen = null;
    render();
    toast(`Mostrando ${empresaActual().nombre}`);
  });

  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.exclusivoCliente || state.accesoUsuarios) return;
      state.modo = btn.dataset.mode;
      render();
      toast(state.modo === 'consultor' ? 'Modo Consultor activado (edición habilitada)' : 'Vista Cliente activada (presentación limpia)');
    });
  });

  document.getElementById('mainTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    render();
  });

  document.getElementById('btnTheme').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    aplicarTema(cur === 'dark' ? 'light' : 'dark');
  });

  document.getElementById('btnPrint').addEventListener('click', () => window.print());
  document.getElementById('btnShare').addEventListener('click', () => { void abrirModalCompartir(empresaActual()); });
  document.getElementById('btnConnectTop')?.addEventListener('click', () => {
    if (state.accesoUsuarios) {
      state.autenticadoPortal = false;
      render();
    } else {
      abrirModalConectarServidor();
    }
  });
  document.getElementById('btnConnectLive').addEventListener('click', abrirModalConectarServidor);
  document.getElementById('btnExportJson').addEventListener('click', exportarJson);

  document.getElementById('btnImportJson').addEventListener('click', () => {
    document.getElementById('jsonFileInput').click();
  });

  document.getElementById('jsonFileInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const txt = await file.text();
      const parsed = JSON.parse(txt);
      if (!parsed || !Array.isArray(parsed.empresas) || !parsed.empresas.length) {
        throw new Error('El archivo no contiene una lista válida de empresas');
      }
      state.data = parsed;
      state.empresaId = parsed.empresas[0].id;
      guardarDatos();
      render();
      toast(`Importadas ${parsed.empresas.length} empresas correctamente`);
    } catch (err) {
      toast(`Error al importar: ${err.message}`);
    } finally {
      e.target.value = '';
    }
  });

  document.getElementById('btnResetDemo').addEventListener('click', () => {
    if (!confirm('¿Restaurar las 4 empresas de demostración originales? Se perderán los cambios locales no exportados.')) return;
    state.data = crearDatosIniciales();
    state.empresaId = state.data.empresas[0].id;
    state.faseSeleccionadaResumen = null;
    guardarDatos();
    render();
    toast('Datos de demostración restaurados');
  });

  // Cierre modal
  document.getElementById('modalClose').addEventListener('click', cerrarModal);
  document.getElementById('modalBackdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modalBackdrop') cerrarModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cerrarModal();
  });

  render();
}

void init();
})();
