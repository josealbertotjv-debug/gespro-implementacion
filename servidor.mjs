/* =====================================================================
   GesPro Pulse · Servidor local ligero (Node 22+, cero dependencias)
   ---------------------------------------------------------------------
   Uso:
     node sitio-implementacion/servidor.mjs
     PORT=4355 node sitio-implementacion/servidor.mjs

   Sirve el portal de implementación y ofrece el puente de SOLO LECTURA
   POST /api/sincronizar-gespro para leer empresas reales, usuarios,
   auditoría de uso por módulo e infraestructura desde GesPro Administrativo
   (con soporte completo para 2FA, protección anti-SSRF y límite de tasa).
   No modifica ningún dato en GesPro ni almacena contraseñas.
   ===================================================================== */

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT || 4350);
const HOST = process.env.HOST || '127.0.0.1';
const SERVIDOR_PREDETERMINADO = (process.env.GESPRO_URL || 'https://gespro-administrativo.gespro.ai').replace(/\/+$/, '');
const ORIGENES_PERMITIDOS = new Set(
  (process.env.GESPRO_ORIGENES_PERMITIDOS || SERVIDOR_PREDETERMINADO)
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

/* Limitador ligero de tasa por IP para proteger /api/sincronizar-gespro */
const intentosPorIp = new Map();
const VENTANA_MS = 15 * 60 * 1000;
const MAX_INTENTOS = 25;

function ipCliente(req) {
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || '127.0.0.1';
}

function esPeticionLocal(req) {
  const host = String(req.headers.host || '');
  const ip = ipCliente(req);
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host) && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
}

function comprobarLimite(ip) {
  const ahora = Date.now();
  const lista = (intentosPorIp.get(ip) || []).filter((t) => ahora - t < VENTANA_MS);
  if (lista.length >= MAX_INTENTOS) return false;
  lista.push(ahora);
  intentosPorIp.set(ip, lista);
  return true;
}

function origenPermitido(urlStr, req) {
  let u;
  try {
    u = new URL(urlStr);
    if (!/^https?:$/.test(u.protocol)) return null;
  } catch {
    return null;
  }
  const orig = u.origin;
  if (ORIGENES_PERMITIDOS.has(orig)) return orig;
  // Solo permitir localhost / 127.0.0.1 si quien consulta está en la propia máquina local
  if (esPeticionLocal(req) && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(orig)) return orig;
  return null;
}

function enviarJson(res, status, data) {
  res.writeHead(status, {
    ...SEC_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

async function leerCuerpoJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 512_000) throw new Error('Solicitud demasiado grande');
  }
  return raw ? JSON.parse(raw) : {};
}

async function apiGet(base, path, headers) {
  try {
    const r = await fetch(`${base}${path}`, { headers });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch {
    return null;
  }
}

async function apiPost(base, path, body, headers) {
  try {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data, res: r };
  } catch (err) {
    return { ok: false, status: 502, data: { error: err.message } };
  }
}

/* Mapeo de módulos de auditoría reales de GesPro Administrativo -> 12 módulos de GesPro Pulse */
const MAPA_MODULO = {
  crm: 'crm',
  campo: 'crm',
  marketing: 'crm',
  comisiones: 'crm',
  pedidos: 'cotizaciones',
  tienda: 'cotizaciones',
  pos: 'pos',
  cxc: 'cxc',
  terceros: 'cxc',
  retenciones_recibidas: 'cxc',
  comprobantes: 'comprobantes',
  cxp: 'cxp',
  pagos: 'cxp',
  inventario: 'inventario',
  manufactura: 'inventario',
  costeo: 'costos',
  importaciones: 'costos',
  bancos: 'bancos',
  tesoreria: 'bancos',
  rrhh: 'rrhh',
  ordenes_pago: 'rrhh',
  contabilidad: 'contabilidad',
  reportes: 'reportes_ia',
};

const TODOS_MODULOS = [
  'crm', 'cotizaciones', 'pos', 'cxc', 'comprobantes', 'cxp',
  'inventario', 'costos', 'bancos', 'rrhh', 'contabilidad', 'reportes_ia',
];

function parseFechaUtc(str) {
  if (!str) return null;
  const s = String(str).trim();
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + (/[Zz]|[+-]\d{2}:?\d{2}$/.test(s) ? '' : 'Z');
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function textoRelativo(ms) {
  if (!ms) return 'Sin actividad registrada';
  const diffMin = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (diffMin < 2) return 'Hace instantes';
  if (diffMin < 60) return `Hace ${diffMin} min`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `Hace ${diffH} h`;
  const diffD = Math.round(diffH / 24);
  if (diffD === 1) return 'Ayer';
  if (diffD <= 45) return `Hace ${diffD} días`;
  return new Date(ms).toISOString().slice(0, 10);
}

function construirTelemetriaEmpresa({ emp, prueba, diag, auditoria, usuarios, bcv, puenteSeniat, latenciaMs }) {
  const ahora = Date.now();
  const d7 = ahora - 7 * 86400_000;
  const d15 = ahora - 15 * 86400_000;
  const d30 = ahora - 30 * 86400_000;
  const logs = Array.isArray(auditoria) ? auditoria : [];
  const regs = diag?.datos?.registros || {};

  const modStats = new Map(TODOS_MODULOS.map((id) => [id, {
    docs30d: 0, ult15: 0, prev15: 0, totalLogs: 0, usuarios: new Set(), ultimoMs: null,
  }]));

  const semanaMs = 7 * 86400_000;
  const semanas = Array.from({ length: 8 }, (_, idx) => ({
    sem: `Sem ${idx + 1}`,
    facturas: 0,
    cobrosPagos: 0,
    inventario: 0,
    asientos: 0,
  }));

  const userLogs = new Map();

  for (const row of logs) {
    const ms = parseFechaUtc(row.fecha);
    const modId = MAPA_MODULO[row.modulo];
    const uname = row.usuario || '';

    if (uname) {
      if (!userLogs.has(uname)) userLogs.set(uname, { ops7: 0, ops30: 0, ultimoMs: null });
      const ul = userLogs.get(uname);
      if (ms && (!ul.ultimoMs || ms > ul.ultimoMs)) ul.ultimoMs = ms;
      if (ms && ms >= d7) ul.ops7++;
      if (ms && ms >= d30) ul.ops30++;
    }

    if (modId && modStats.has(modId)) {
      const st = modStats.get(modId);
      st.totalLogs++;
      if (ms && (!st.ultimoMs || ms > st.ultimoMs)) st.ultimoMs = ms;
      if (ms && ms >= d30) {
        st.docs30d++;
        if (uname) st.usuarios.add(uname);
      }
      if (ms && ms >= d15) st.ult15++;
      else if (ms && ms >= d30) st.prev15++;
    }

    if (ms) {
      const weeksAgo = Math.floor((ahora - ms) / semanaMs);
      if (weeksAgo >= 0 && weeksAgo < 8) {
        const bucket = semanas[7 - weeksAgo];
        if (['cxc', 'pedidos', 'pos', 'tienda', 'crm', 'campo'].includes(row.modulo)) bucket.facturas++;
        else if (['bancos', 'tesoreria', 'comprobantes', 'pagos', 'cxp'].includes(row.modulo)) bucket.cobrosPagos++;
        else if (['inventario', 'manufactura', 'costeo', 'importaciones'].includes(row.modulo)) bucket.inventario++;
        else if (['contabilidad', 'rrhh', 'ordenes_pago'].includes(row.modulo)) bucket.asientos++;
      }
    }
  }

  const listaUsuarios = (Array.isArray(usuarios) ? usuarios : []).filter((u) => u.activo !== 0);
  const usuariosCon2fa = listaUsuarios.filter((u) => u.dos_pasos || u.totp_activo).length;
  const adopcion2fa = listaUsuarios.length ? Math.round((usuariosCon2fa / listaUsuarios.length) * 100) : 0;

  const usuariosMapeados = listaUsuarios.map((u) => {
    const ul = userLogs.get(u.usuario) || { ops7: 0, ops30: 0, ultimoMs: null };
    const accMs = Math.max(parseFechaUtc(u.ultimo_acceso) || 0, ul.ultimoMs || 0) || null;
    const diasSinEntrar = accMs ? (ahora - accMs) / 86400_000 : 999;
    let estado = 'inactivo';
    if (ul.ops30 >= 25 || (ul.ops7 >= 5 && diasSinEntrar <= 4)) estado = 'campeon';
    else if (diasSinEntrar <= 7 || ul.ops7 > 0) estado = 'activo';
    else if (diasSinEntrar <= 21 || ul.ops30 > 0) estado = 'refuerzo';

    const rolesTxt = Array.isArray(u.roles) && u.roles.length ? u.roles.join(', ') : (u.rol || 'consulta');
    return {
      nombre: u.nombre || u.usuario,
      area: u.email ? `${rolesTxt} · ${u.email}` : rolesTxt,
      rol: u.rol || (Array.isArray(u.roles) ? u.roles[0] : 'consulta'),
      sesionesSemana: ul.ops7 > 0 ? ul.ops7 : (diasSinEntrar <= 7 ? 1 : 0),
      operaciones30d: ul.ops30,
      academiaPct: estado === 'campeon' ? 95 : estado === 'activo' ? 75 : estado === 'refuerzo' ? 40 : 10,
      ultimoAcceso: accMs ? textoRelativo(accMs) : 'Sin acceso registrado',
      estado,
    };
  });

  const evidenciaDb = {
    cxc: Number(regs.documentos ?? emp.documentos ?? 0),
    comprobantes: Number(regs.comprobantes ?? 0),
    inventario: Number(regs.movimientos_inventario ?? 0) + Number(regs.articulos ?? emp.articulos ?? 0),
    bancos: Number(regs.movimientos_banco ?? 0) + Number(regs.extracto_lineas ?? 0),
    contabilidad: Number(regs.asientos ?? emp.asientos ?? 0),
  };

  const totalDocs = Number(regs.documentos ?? emp.documentos ?? 0);
  const totalTerceros = Number(regs.terceros ?? emp.terceros ?? 0);
  const totalArticulos = Number(regs.articulos ?? emp.articulos ?? 0);
  const totalAsientos = Number(regs.asientos ?? emp.asientos ?? 0);
  const diasDesdeUltMov = emp.ultimo_movimiento ? (ahora - (parseFechaUtc(emp.ultimo_movimiento) || ahora)) / 86400_000 : 999;

  const modulos = TODOS_MODULOS.map((id) => {
    const st = modStats.get(id);
    const dbCount = evidenciaDb[id] || 0;
    const diasUlt = st.ultimoMs ? (ahora - st.ultimoMs) / 86400_000 : 999;
    const tendencia = st.prev15 > 0
      ? Math.round(((st.ult15 - st.prev15) / st.prev15) * 100)
      : (st.ult15 > 0 ? 100 : 0);

    let estado = 'pendiente';
    let adopcion = 0;
    let nota = 'Sin registros recientes en auditoría.';

    if (st.docs30d >= 8 && diasUlt <= 10) {
      estado = 'activo';
      adopcion = Math.min(100, Math.max(75, Math.round(70 + Math.min(30, st.docs30d / 2))));
      nota = `${st.docs30d} acciones registradas en los últimos 30 días (${st.usuarios.size || 1} usuario/s activos).`;
    } else if (st.docs30d > 0) {
      estado = diasUlt > 14 ? 'sin_uso' : 'parcial';
      adopcion = Math.min(72, Math.max(25, Math.round(25 + st.docs30d * 5)));
      nota = diasUlt > 14
        ? `Actividad detenida (${textoRelativo(st.ultimoMs)}). Solo ${st.docs30d} registros en 30 días.`
        : `Uso intermitente: ${st.docs30d} acciones registradas en los últimos 30 días.`;
    } else if (st.totalLogs > 0 || dbCount > 5) {
      estado = 'sin_uso';
      adopcion = 15;
      nota = st.ultimoMs
        ? `Tuvo actividad previa (${textoRelativo(st.ultimoMs)}), pero sin movimientos en los últimos 30 días.`
        : `Posee ${dbCount} registros en base de datos, sin actividad reciente en auditoría.`;
    }

    return {
      id,
      estado,
      docs30d: st.docs30d,
      tendencia,
      usuariosActivos: st.usuarios.size,
      usuariosAsignados: Math.max(st.usuarios.size, listaUsuarios.length ? Math.min(3, listaUsuarios.length) : 1),
      ultimoUso: st.ultimoMs ? textoRelativo(st.ultimoMs) : (dbCount > 0 ? 'Solo histórico BD' : 'Sin uso'),
      adopcion,
      nota,
    };
  });

  const tieneTest = !!prueba;
  const tieneMaestros = totalTerceros >= 3 || totalArticulos >= 3;
  const tieneUsuarios = listaUsuarios.length >= 2;
  const tieneDocs = totalDocs > 0;
  const tieneOperacionActiva = totalDocs >= 10 && totalAsientos >= 10;
  const tieneBancos = Number(regs.movimientos_banco ?? 0) > 0 || Number(regs.extracto_lineas ?? 0) > 0;
  const tieneConciliacion = Number(regs.extracto_lineas ?? 0) > 0;
  const operacionReciente = diasDesdeUltMov <= 10 || logs.some((r) => (parseFechaUtc(r.fecha) || 0) >= d7);

  const faseHints = {
    f1: [
      'completado',
      tieneTest ? 'completado' : 'pendiente',
      'completado',
      puenteSeniat?.ultimo_contacto ? 'completado' : 'pendiente',
      usuariosMapeados.some((u) => u.ultimoAcceso !== 'Sin acceso registrado') ? 'completado' : 'en_curso',
    ],
    f2: [
      emp.identificacion ? 'completado' : 'en_curso',
      totalAsientos > 0 ? 'completado' : 'en_curso',
      (diag?.datos?.filas_totales || 0) > 0 ? 'completado' : 'en_curso',
      tieneUsuarios ? (adopcion2fa >= 50 ? 'completado' : 'en_curso') : 'pendiente',
      tieneMaestros ? 'completado' : 'en_curso',
    ],
    f3: [
      modulos.find((m) => m.id === 'crm')?.docs30d > 0 ? 'completado' : 'pendiente',
      tieneDocs ? 'completado' : 'pendiente',
      modulos.find((m) => m.id === 'cxp')?.docs30d > 0 ? 'completado' : 'pendiente',
      totalArticulos > 0 ? 'completado' : 'pendiente',
      tieneBancos ? 'completado' : 'pendiente',
      usuariosMapeados.filter((u) => u.sesionesSemana > 0).length >= Math.max(1, Math.ceil(usuariosMapeados.length / 2)) ? 'completado' : 'en_curso',
    ],
    f4: [
      tieneDocs ? 'completado' : 'pendiente',
      modulos.find((m) => m.id === 'cxp')?.docs30d > 0 || totalDocs >= 5 ? 'completado' : 'pendiente',
      tieneConciliacion ? 'completado' : (tieneBancos ? 'en_curso' : 'pendiente'),
      totalAsientos >= 5 ? 'completado' : 'pendiente',
    ],
    f5: [
      totalArticulos > 0 && Number(regs.movimientos_inventario ?? 0) > 0 ? 'completado' : 'pendiente',
      totalAsientos >= 5 ? 'completado' : 'pendiente',
      tieneOperacionActiva ? 'completado' : (tieneDocs ? 'en_curso' : 'pendiente'),
      operacionReciente && tieneOperacionActiva ? 'completado' : 'pendiente',
    ],
    f6: [
      operacionReciente && tieneOperacionActiva ? 'en_curso' : 'pendiente',
      tieneConciliacion && totalAsientos >= 20 ? 'completado' : 'pendiente',
      modulos.find((m) => m.id === 'reportes_ia')?.docs30d > 0 ? 'completado' : 'pendiente',
      'pendiente',
    ],
  };

  const bloqueos = [];
  if (!tieneMaestros) {
    bloqueos.push({
      id: `auto-maestros-${emp.codigo}`,
      titulo: 'Carga pendiente de maestros (clientes, proveedores o artículos)',
      descripcion: `Actualmente registra ${totalTerceros} terceros y ${totalArticulos} artículos en la base de datos.`,
      responsable: 'Cliente',
      prioridad: 'alta',
      fase: 'Configuración',
      fechaLimite: new Date(ahora + 5 * 86400_000).toISOString().slice(0, 10),
      resuelto: false,
    });
  }
  if (tieneOperacionActiva && !operacionReciente) {
    bloqueos.push({
      id: `auto-inactividad-${emp.codigo}`,
      titulo: 'Alerta de inactividad reciente en el ERP',
      descripcion: `Último movimiento contable registrado: ${emp.ultimo_movimiento || 'sin fecha'}. Conviene validar con el cliente si requiere acompañamiento.`,
      responsable: 'Ambos',
      prioridad: 'alta',
      fase: 'Estabilización',
      fechaLimite: new Date(ahora + 3 * 86400_000).toISOString().slice(0, 10),
      resuelto: false,
    });
  }
  if (listaUsuarios.length > 0 && adopcion2fa < 80) {
    bloqueos.push({
      id: `auto-2fa-${emp.codigo}`,
      titulo: `Activar verificación en dos pasos (2FA) en el equipo (${adopcion2fa}% actual)`,
      descripcion: `${usuariosCon2fa} de ${listaUsuarios.length} usuarios tienen 2FA activo.`,
      responsable: 'Cliente',
      prioridad: 'media',
      fase: 'Configuración',
      fechaLimite: new Date(ahora + 7 * 86400_000).toISOString().slice(0, 10),
      resuelto: false,
    });
  }

  const ultimoMovTxt = emp.ultimo_movimiento ? `Último asiento: ${emp.ultimo_movimiento}.` : 'Sin asientos registrados aún.';
  const resumenEjecutivo = !emp.activa
    ? 'Empresa actualmente desactivada en la plataforma GesPro Administrativo.'
    : tieneOperacionActiva && operacionReciente
      ? `Empresa en operación activa en GesPro Administrativo (${totalDocs} documentos, ${totalAsientos} asientos, ${listaUsuarios.length} usuarios). ${ultimoMovTxt}`
      : tieneDocs
        ? `Empresa con actividad inicial/piloto (${totalDocs} documentos, ${totalTerceros} terceros, ${totalArticulos} artículos). ${ultimoMovTxt}`
        : `Empresa dada de alta en GesPro (${totalTerceros} terceros, ${totalArticulos} artículos, ${listaUsuarios.length} usuarios). Pendiente iniciar carga operativa.`;

  const bcvTxt = bcv?.ultima_tasa
    ? `Tasa ${bcv.ultima_tasa} (${bcv.ultima_fecha || 'vigente'})`
    : (bcv?.activo ? 'Sincronización automática activa' : 'Manual / sin sincronizar');

  const seniatTxt = puenteSeniat?.ultimo_contacto
    ? `Conectado (${textoRelativo(parseFechaUtc(puenteSeniat.ultimo_contacto))})`
    : 'Sin puente configurado';

  const motorTxt = diag?.datos?.archivo
    ? (diag.datos.archivo.startsWith('PostgreSQL') ? 'PostgreSQL 16' : 'SQLite WAL')
    : 'PostgreSQL 16';

  return {
    id: emp.codigo,
    codigo: emp.codigo,
    nombre: emp.nombre,
    rif: emp.identificacion || 'Sin RIF registrado',
    sector: emp.notas ? String(emp.notas).slice(0, 60) : 'Empresa activa · GesPro Administrativo',
    plan: `${motorTxt} · Moneda ${emp.moneda_base || 'USD'}`,
    monedaBase: emp.moneda_base || 'USD',
    consultor: 'Equipo GesPro',
    sponsorCliente: listaUsuarios.find((u) => (u.roles || [u.rol]).includes('admin'))?.nombre || 'Administrador Empresa',
    fechaInicio: (emp.creada_en || new Date().toISOString()).slice(0, 10),
    fechaGoLive: emp.ultimo_movimiento || new Date(ahora + 30 * 86400_000).toISOString().slice(0, 10),
    resumenEjecutivo,
    origenReal: true,
    infraestructura: {
      estado: emp.activa ? 'EN LINEA' : 'INACTIVA',
      uptime: diag?.equipo?.encendido_dias ? Math.min(99.99, Number((99.5 + Math.min(0.48, diag.equipo.encendido_dias / 100)).toFixed(2))) : 99.9,
      latenciaMs: latenciaMs || 45,
      motor: motorTxt,
      version: diag?.proceso?.node ? `GesPro · Node ${diag.proceso.node}` : 'GesPro Administrativo',
      servidor: diag?.equipo?.anfitrion || 'Servidor GesPro Producción',
      ultimoRespaldo: diag?.datos ? `BD ${diag.datos.base_mb ?? 0} MB · Adjuntos ${diag.datos.adjuntos_mb ?? 0} MB` : 'Respaldo diario automático',
      ambienteTest: prueba?.refrescada_en ? `Actualizado ${textoRelativo(parseFechaUtc(prueba.refrescada_en))}` : (prueba ? 'Activo (-TEST)' : 'Sin ambiente -TEST'),
      puenteSeniat: seniatTxt,
      tasaBcv: bcvTxt,
      adopcion2fa,
      documentosTotal: totalDocs,
      tercerosTotal: totalTerceros,
      articulosTotal: totalArticulos,
      asientosTotal: totalAsientos,
    },
    actividadSemanal: semanas,
    faseHints,
    modulos,
    usuarios: usuariosMapeados,
    bloqueos,
    bitacora: [
      {
        fecha: new Date().toISOString().slice(0, 10),
        tipo: operacionReciente ? 'ok' : (tieneDocs ? 'warn' : 'info'),
        titulo: 'Sincronización en vivo con servidor GesPro',
        detalle: `Lectura real: ${totalDocs} documentos, ${totalTerceros} terceros, ${totalArticulos} artículos, ${totalAsientos} asientos y ${listaUsuarios.length} usuarios (${logs.length} eventos de auditoría analizados).`,
      },
      ...logs.slice(0, 6).map((l) => ({
        fecha: String(l.fecha || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
        tipo: 'info',
        titulo: `[${l.modulo}] ${l.accion}`,
        detalle: `Usuario: ${l.usuario || 'sistema'}${l.detalle ? ` · ${String(l.detalle).slice(0, 120)}` : ''}`,
      })),
    ],
  };
}

async function sincronizarGesPro(req, res) {
  const t0 = Date.now();
  const ip = ipCliente(req);
  if (!comprobarLimite(ip)) {
    return enviarJson(res, 429, { error: 'Demasiados intentos recientes. Espere unos minutos e inténtelo de nuevo.' });
  }

  try {
    const { url, usuario, password, token_parcial, codigo } = await leerCuerpoJson(req);
    const destino = url || SERVIDOR_PREDETERMINADO;
    const base = origenPermitido(destino, req);
    if (!base) {
      return enviarJson(res, 403, { error: `Servidor no autorizado. Este portal solo conecta con ${SERVIDOR_PREDETERMINADO}.` });
    }

    let authResp;
    if (token_parcial && codigo) {
      authResp = await apiPost(base, '/api/login/segundo-factor', {
        token_parcial: String(token_parcial),
        codigo: String(codigo).trim(),
      }, {});
    } else {
      if (!usuario || !password) {
        return enviarJson(res, 400, { error: 'Ingresa usuario y contraseña' });
      }
      authResp = await apiPost(base, '/api/login', { usuario, password }, {});
    }

    if (!authResp.ok) {
      return enviarJson(res, authResp.status || 401, {
        error: authResp.data?.error || 'Credenciales incorrectas o servidor no disponible',
      });
    }

    if (authResp.data?.requiere_segundo_factor) {
      return enviarJson(res, 200, {
        requiere_2fa: true,
        token_parcial: authResp.data.token_parcial,
        usuario: authResp.data.usuario,
      });
    }

    const token = authResp.data?.token;
    const setCookies = authResp.res?.headers?.getSetCookie ? authResp.res.headers.getSetCookie() : [];
    const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');
    const authHeaders = { Accept: 'application/json' };
    if (token) authHeaders.Authorization = `Bearer ${token}`;
    if (cookieHeader) authHeaders.Cookie = cookieHeader;

    const latenciaMs = Math.max(1, Date.now() - t0);

    try {
      const [empresasRaw, puenteSeniat, plataformaUsuarios] = await Promise.all([
        apiGet(base, '/api/empresas?resumen=1', authHeaders),
        apiGet(base, '/api/seniat/puente', authHeaders),
        apiGet(base, '/api/plataforma/usuarios', authHeaders),
      ]);

      if (!Array.isArray(empresasRaw)) {
        return enviarJson(res, 502, { error: 'No se pudo obtener la lista de empresas desde GesPro' });
      }

      const mapaUltAcceso = new Map();
      if (Array.isArray(plataformaUsuarios)) {
        for (const u of plataformaUsuarios) {
          mapaUltAcceso.set(u.id, { ultimo_acceso: u.ultimo_acceso, totp_activo: u.totp_activo });
        }
      }

      const pruebasPorProd = new Map();
      for (const e of empresasRaw) {
        if (e.es_prueba && e.produccion_id) pruebasPorProd.set(e.produccion_id, e);
      }
      const reales = empresasRaw.filter((e) => !e.es_prueba);

      const empresasProcesadas = [];

      for (const emp of reales) {
        let diag = null;
        let auditoria = [];
        let bcv = null;
        let usuarios = await apiGet(base, `/api/empresas/${emp.id}/usuarios`, authHeaders);

        if (emp.activa) {
          const sw = await apiPost(base, '/api/sesion/empresa', { empresa_id: emp.id }, authHeaders);
          if (sw.ok) {
            const [d, aud, bcvRes, cfgUsr] = await Promise.all([
              apiGet(base, '/api/infraestructura/diagnostico', authHeaders),
              apiGet(base, '/api/config/auditoria?limite=2000', authHeaders),
              apiGet(base, '/api/config/bcv', authHeaders),
              apiGet(base, '/api/config/usuarios', authHeaders),
            ]);
            diag = d;
            if (Array.isArray(aud)) auditoria = aud;
            bcv = bcvRes;
            if (Array.isArray(cfgUsr) && cfgUsr.length) usuarios = cfgUsr;
          }
        }

        if (Array.isArray(usuarios)) {
          usuarios = usuarios.map((u) => {
            const extra = mapaUltAcceso.get(u.id);
            return extra ? { ...u, ultimo_acceso: u.ultimo_acceso || extra.ultimo_acceso, totp_activo: u.totp_activo ?? extra.totp_activo } : u;
          });
        }

        empresasProcesadas.push(construirTelemetriaEmpresa({
          emp,
          prueba: pruebasPorProd.get(emp.id) || null,
          diag,
          auditoria,
          usuarios,
          bcv,
          puenteSeniat,
          latenciaMs,
        }));
      }

      return enviarJson(res, 200, {
        ok: true,
        origen: base,
        usuario: authResp.data?.usuario?.nombre || authResp.data?.usuario?.usuario || usuario,
        esSuperadmin: !!authResp.data?.usuario?.superadmin,
        totalEmpresas: empresasProcesadas.length,
        empresas: empresasProcesadas,
      });
    } finally {
      await apiPost(base, '/api/logout', {}, authHeaders).catch(() => {});
    }
  } catch (err) {
    return enviarJson(res, 502, { error: err.message || 'Error conectando con GesPro' });
  }
}

const server = createServer(async (req, res) => {
  const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (reqUrl.pathname === '/api/modo-servidor' && req.method === 'GET') {
    return enviarJson(res, 200, {
      vivo: true,
      servidorPredeterminado: SERVIDOR_PREDETERMINADO,
      esLocal: esPeticionLocal(req),
    });
  }

  if (reqUrl.pathname === '/api/sincronizar-gespro' && req.method === 'POST') {
    return sincronizarGesPro(req, res);
  }

  let relPath = decodeURIComponent(reqUrl.pathname);
  if (relPath === '/') relPath = '/index.html';
  const safePath = normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = resolve(join(ROOT, safePath));

  if (!fullPath.startsWith(ROOT) || !existsSync(fullPath) || !statSync(fullPath).isFile()) {
    res.writeHead(404, { ...SEC_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Archivo no encontrado');
  }

  const ext = extname(fullPath).toLowerCase();
  res.writeHead(200, {
    ...SEC_HEADERS,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(readFileSync(fullPath));
});

server.listen(PORT, HOST, () => {
  console.log(`\n  GesPro Pulse · Portal de Implementación y Estado de Uso`);
  console.log(`  Disponible en: http://${HOST}:${PORT}`);
  console.log(`  Servidor GesPro autorizado: ${SERVIDOR_PREDETERMINADO}\n`);
});
