/**
 * Carga y modificación de registros en Notion (herramienta guardar_registro).
 *
 * Flujo en dos pasos, con control del lado del servidor:
 *   1. guardar_registro SIN token → valida y convierte los datos, informa qué falta y devuelve un
 *      resumen + token. No escribe nada.
 *   2. El agente le lee el resumen al usuario y espera su confirmación en OTRO mensaje.
 *   3. guardar_registro CON el token → recién ahí crea o actualiza la página.
 * El token es un HMAC de los datos ya convertidos: si cambian, no sirve. Y se rechaza si se generó en
 * el mismo turno (el modelo no puede "autoconfirmarse" sin que el usuario haya respondido).
 *
 * Los valores llegan simples ("Turno": "Noche", "Monto": 250000, "Cliente": "Carla Sforza") y se pasan
 * al formato de la API según el tipo de cada columna. Las relaciones aceptan id o nombre del registro.
 */

var TOKENS_TURNO_ = {};   // tokens emitidos durante este turno (cada pedido a la web app es una ejecución nueva)
var GUARDADOS_TURNO_ = []; // registros guardados de verdad en este turno
const TIPOS_SOLO_LECTURA = ['formula', 'rollup', 'created_time', 'created_by', 'last_edited_time',
  'last_edited_by', 'unique_id', 'button', 'verification', 'files', 'people'];

/** Lo llaman los loops de Claude y Gemini al empezar cada pregunta. */
function nuevoTurno_() { TOKENS_TURNO_ = {}; GUARDADOS_TURNO_ = []; }

/**
 * @param {Object} input {data_source_id?, page_id?, propiedades, token?}
 *   - Para crear: data_source_id (id, alias o título) y propiedades.
 *   Los obligatorios de cada base se configuran en su archivo Sistema_*.gs.
 *   - Para modificar: page_id (id o URL) y solo las propiedades que cambian.
 */
function guardarRegistro_(input) {
  const props = parseJson_(input.propiedades, 'propiedades') || {};
  if (typeof props !== 'object' || Array.isArray(props) || !Object.keys(props).length) {
    throw new Error('Faltan las propiedades a guardar: {"Columna": valor, ...}.');
  }
  const pageId = input.page_id ? idDePagina_(input.page_id) : null;
  let dsId = input.data_source_id;
  if (pageId && !dsId) {
    const pg = notion_('get', '/pages/' + pageId);
    dsId = pg.parent && (pg.parent.data_source_id || pg.parent.database_id);
    if (!dsId) throw new Error('Esa página no pertenece a una base de datos.');
  }
  if (!dsId) throw new Error('Indicá la base (data_source_id) para crear, o el page_id para modificar.');

  const esq = verEsquema_(dsId);
  const porNombre = {};
  esq.propiedades.forEach(function (p) { porNombre[p.nombre.toLowerCase()] = p; });

  const errores = [], notion = {}, legible = {};
  Object.keys(props).forEach(function (nombre) {
    const p = porNombre[nombre.toLowerCase()];
    if (!p) { errores.push('"' + nombre + '" no es una columna de ' + esq.titulo); return; }
    if (TIPOS_SOLO_LECTURA.indexOf(p.tipo) >= 0) { errores.push('"' + p.nombre + '" se calcula sola o no se puede cargar desde acá (' + p.tipo + ')'); return; }
    try {
      const r = valorANotion_(p, props[nombre]);
      notion[p.nombre] = r.notion;
      legible[p.nombre] = r.legible;
    } catch (e) { errores.push(p.nombre + ': ' + e.message); }
  });

  const reglas = camposDe_(esq.titulo, esq.data_source_id);
  const faltan = pageId ? [] : reglas.obligatorios.filter(function (n) { return !(n in notion) && !errores.some(function (e) { return e.indexOf(n) === 0; }); });
  const recomendados = pageId ? [] : reglas.recomendados.filter(function (n) { return !(n in notion); });

  const advertencias = [];
  const hoy = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  (reglas.fechas_futuras || []).forEach(function (n) {
    const d = notion[n] && notion[n].date;
    if (d && d.start.slice(0, 10) < hoy) advertencias.push('"' + n + '" es una fecha pasada (' + legible[n] + '). Si el usuario no dijo el año, seguramente es el año próximo: corregilo o preguntale.');
  });
  const accion = pageId ? 'actualizar' : 'crear';
  const firma = firmar_([accion, esq.data_source_id, pageId || '', JSON.stringify(ordenar_(notion))].join('|'));

  // Paso 1: resumen (no escribe)
  if (!input.token) {
    const out = { accion: accion, base: esq.titulo, valores: legible };
    if (pageId) out.page_id = pageId;
    if (errores.length) out.errores = errores;
    if (faltan.length) out.faltan = faltan;
    if (recomendados.length) out.recomendados_sin_completar = recomendados;
    if (advertencias.length) out.advertencias = advertencias;
    if (!errores.length && !faltan.length) {
      out.token = firma;
      TOKENS_TURNO_[firma] = true;
      out.siguiente_paso = 'NO se guardó nada todavía. Leele al usuario un resumen corto (y mencioná los recomendados sin completar, si hay) y preguntale si lo cargás. Solo cuando confirme en su próximo mensaje, llamá de nuevo a guardar_registro con las mismas propiedades y este token.';
    } else {
      out.siguiente_paso = 'Pedile al usuario lo que falta o corregí los errores (de a uno o dos datos por vez) y volvé a llamar sin token.';
    }
    return out;
  }

  // Paso 2: confirmación
  if (errores.length || faltan.length) throw new Error('No se puede guardar: ' + errores.concat(faltan.map(function (f) { return 'falta ' + f; })).join('; '));
  if (input.token !== firma) throw new Error('El token no corresponde a estos datos (cambiaron desde el resumen). Generá un resumen nuevo sin token y volvé a pedir confirmación.');
  if (TOKENS_TURNO_[firma]) {
    return { guardado: false, estado: 'NO SE GUARDÓ: falta la confirmación del usuario',
      siguiente_paso: 'No digas que guardaste nada. Leele el resumen al usuario y preguntale si lo cargás; se guarda recién cuando confirme en su próximo mensaje.' };
  }

  let pg;
  if (pageId) {
    pg = notion_('patch', '/pages/' + pageId, { properties: notion });
  } else {
    pg = notion_('post', '/pages', { parent: { type: 'data_source_id', data_source_id: esq.data_source_id }, properties: notion });
  }
  GUARDADOS_TURNO_.push({ base: esq.titulo, id: pg.id });
  return { ok: true, guardado: true, accion: accion === 'crear' ? 'creado' : 'actualizado', base: esq.titulo, id: pg.id, url: pg.url, valores: legible };
}

/** Reglas de carga de una base (de su archivo Sistema_*.gs). Sin configuración: sin obligatorios. */
function camposDe_(titulo, id) {
  const r = configDeBase_(titulo, id);
  const c = r ? r.config : {};
  return { obligatorios: c.obligatorios || [], recomendados: c.recomendados || [], fechas_futuras: c.fechas_futuras || [], buscar_por: c.buscar_por || [] };
}

/** Convierte un valor simple al formato de la API según el tipo de la columna. */
function valorANotion_(p, v) {
  const texto = function (x) { return String(x === null || x === undefined ? '' : x).trim(); };
  const opcion = function (nombre) {
    const t = texto(nombre);
    const op = (p.opciones || []).find(function (o) { return o.toLowerCase() === t.toLowerCase(); });
    if (!op) throw new Error('"' + t + '" no es una opción válida. Opciones: ' + (p.opciones || []).join(', '));
    return op;
  };
  switch (p.tipo) {
    case 'title':
    case 'rich_text': {
      const t = texto(v);
      const obj = {}; obj[p.tipo] = [{ type: 'text', text: { content: t.slice(0, 2000) } }];
      return { notion: obj, legible: t };
    }
    case 'number': {
      const n = typeof v === 'number' ? v : Number(texto(v).replace(/\./g, '').replace(',', '.').replace(/[^0-9.\-]/g, ''));
      if (!isFinite(n)) throw new Error('"' + v + '" no es un número');
      return { notion: { number: n }, legible: n };
    }
    case 'checkbox': {
      const b = typeof v === 'boolean' ? v : /^(s[ií]|true|1|verdadero)$/i.test(texto(v));
      return { notion: { checkbox: b }, legible: b };
    }
    case 'select': { const o = opcion(v); return { notion: { select: { name: o } }, legible: o }; }
    case 'status': { const o = opcion(v); return { notion: { status: { name: o } }, legible: o }; }
    case 'multi_select': {
      const lista = (Array.isArray(v) ? v : texto(v).split(',')).map(texto).filter(String).map(opcion);
      return { notion: { multi_select: lista.map(function (n) { return { name: n }; }) }, legible: lista };
    }
    case 'date': {
      const d = fechaANotion_(v);
      return { notion: { date: d }, legible: d.end ? { inicio: fechaLegible_(d.start), fin: fechaLegible_(d.end) } : fechaLegible_(d.start) };
    }
    case 'url':
    case 'email':
    case 'phone_number': {
      const t = texto(v);
      const obj = {}; obj[p.tipo] = t || null;
      return { notion: obj, legible: t };
    }
    case 'relation': {
      if (!p.relacionada_con) throw new Error('no sé a qué base apunta esta relación');
      const lista = (Array.isArray(v) ? v : [v]).map(texto).filter(String);
      const encontrados = lista.map(function (x) { return resolverRelacion_(p, x); });
      return { notion: { relation: encontrados.map(function (r) { return { id: r.id }; }) }, legible: encontrados.map(function (r) { return r.titulo; }) };
    }
    default:
      throw new Error('tipo ' + p.tipo + ' no soportado para cargar');
  }
}

/** "2026-12-19", "2026-12-19T20:00", o {inicio, fin}. Sin zona horaria → Buenos Aires. */
function fechaANotion_(v) {
  const obj = (v && typeof v === 'object') ? v : { inicio: v };
  const ini = String(obj.inicio || obj.start || '').trim();
  const fin = String(obj.fin || obj.end || '').trim();
  const valida = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:\d{2}|Z)?)?$/;
  if (!valida.test(ini) || (fin && !valida.test(fin))) throw new Error('fecha inválida "' + JSON.stringify(v) + '": usá AAAA-MM-DD o AAAA-MM-DDTHH:MM');
  const d = { start: ini };
  if (fin) d.end = fin;
  const conHora = /T/.test(ini);
  const conZona = /([+-]\d{2}:\d{2}|Z)$/.test(ini);
  if (conHora && !conZona) d.time_zone = Session.getScriptTimeZone();
  return d;
}

/** "2027-03-13T21:00" → "2027-03-13 21:00 (sábado)": el día de la semana deja ver errores de fecha. */
function fechaLegible_(iso) {
  const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/);
  if (!m) return iso;
  const dia = dias[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
  return m[1] + '-' + m[2] + '-' + m[3] + (m[4] ? ' ' + m[4] : '') + ' (' + dia + ')';
}

/**
 * Red de seguridad: si la respuesta dice que algo se guardó pero en este turno no se guardó nada,
 * se agrega una aclaración (el modelo a veces se adelanta).
 */
function verificarRespuesta_(texto) {
  const afirma = /(^|[^a-záéíóúñ])(guardé|cargué|registré|agregué|actualicé|modifiqué|creé)(?![a-záéíóúñ])|qued[oó] (guardad|cargad|registrad|actualizad)|(se|fue) (guard|carg|registr|actualiz)(ó|ado|ada)(?![a-záéíóúñ])/i.test(texto || '');
  if (afirma && !GUARDADOS_TURNO_.length) {
    return texto + ' Aclaración: todavía no se guardó nada en Notion; se carga cuando me confirmes.';
  }
  return texto;
}

/** Busca un registro de la base relacionada por id o por nombre (título). */
function resolverRelacion_(p, valor) {
  const hex = valor.replace(/-/g, '');
  if (/^[0-9a-f]{32}$/i.test(hex) || /notion\.(so|com)/.test(valor)) {
    const id = idDePagina_(valor);
    const pg = notion_('get', '/pages/' + id);
    const t = Object.keys(pg.properties || {}).map(function (k) { return pg.properties[k]; }).find(function (x) { return x.type === 'title'; });
    return { id: pg.id, titulo: t ? textoPlano_(t.title) : id };
  }
  const esq = verEsquema_(p.relacionada_con);
  const tituloProp = esq.propiedades.find(function (x) { return x.tipo === 'title'; });
  // Columnas donde buscar: las de buscar_por del archivo Sistema_*.gs (título o texto) o, si no hay, solo el título.
  const buscarPor = (camposDe_(esq.titulo, esq.data_source_id).buscar_por || []).map(function (n) {
    return esq.propiedades.find(function (x) { return x.nombre.toLowerCase() === n.toLowerCase() && (x.tipo === 'title' || x.tipo === 'rich_text'); });
  }).filter(Boolean);
  if (!buscarPor.length) buscarPor.push(tituloProp);
  const condiciones = buscarPor.map(function (x) { const f = { property: x.nombre }; f[x.tipo] = { contains: valor }; return f; });
  const r = notion_('post', '/data_sources/' + esq.data_source_id + '/query', {
    page_size: 10, filter: condiciones.length > 1 ? { or: condiciones } : condiciones[0]
  });
  const extra = buscarPor.filter(function (x) { return x !== tituloProp; });
  const cands = (r.results || []).filter(function (pg) { return !pg.in_trash && !pg.archived; }).map(function (pg) {
    const titulo = textoPlano_((pg.properties[tituloProp.nombre] || {}).title);
    const otros = extra.map(function (x) { return textoPlano_((pg.properties[x.nombre] || {}).rich_text || (pg.properties[x.nombre] || {}).title); }).filter(String);
    return { id: pg.id, titulo: titulo + (otros.length && otros.join() !== titulo ? ' (' + otros.join(', ') + ')' : ''), textos: [titulo].concat(otros) };
  });
  const exacto = cands.filter(function (c) { return c.textos.some(function (t) { return t.toLowerCase().trim() === valor.toLowerCase(); }); });
  if (exacto.length === 1) return exacto[0];
  if (cands.length === 1) return cands[0];
  if (!cands.length) throw new Error('no encontré "' + valor + '" en ' + esq.titulo + '. Si es nuevo, ofrecé crearlo primero en ' + esq.titulo + '.');
  throw new Error('hay varios en ' + esq.titulo + ' que coinciden con "' + valor + '": ' + cands.map(function (c) { return c.titulo + ' (' + c.id + ')'; }).join('; ') + '. Preguntá cuál es y pasá su id.');
}

function idDePagina_(v) {
  const s = String(v || '');
  const m = s.replace(/-/g, '').match(/[0-9a-f]{32}/i);
  if (!m) throw new Error('"' + v + '" no es un id ni una URL de Notion válida');
  return m[0];
}

function firmar_(texto) {
  const sig = Utilities.computeHmacSha256Signature(texto, prop_('APP_KEY', true) + '|guardar');
  return Utilities.base64EncodeWebSafe(sig).slice(0, 22);
}

/** Copia con claves ordenadas (para que la firma no dependa del orden). */
function ordenar_(o) {
  if (Array.isArray(o)) return o.map(ordenar_);
  if (o && typeof o === 'object') {
    const out = {};
    Object.keys(o).sort().forEach(function (k) { out[k] = ordenar_(o[k]); });
    return out;
  }
  return o;
}
