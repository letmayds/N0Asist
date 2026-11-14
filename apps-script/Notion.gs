/**
 * Cliente de la API oficial de Notion + normalización de propiedades.
 *
 * Versión de API: NOTION_VERSION (Config.gs). Las bases ("databases") son contenedores de uno o
 * más "data sources"; las consultas y los esquemas se hacen sobre el data source:
 *   POST /v1/search                              (filter.value = "data_source")
 *   GET  /v1/databases/{id}                      → data_sources[] (para traducir ids de base)
 *   GET  /v1/data_sources/{id}                   → esquema
 *   POST /v1/data_sources/{id}/query             → filas (filter, sorts, filter_properties[])
 *   GET  /v1/pages/{id}                          → una página
 *   GET  /v1/pages/{id}/properties/{prop_id}     → valor completo de rollups/relaciones largas
 *
 * Funciones que usa el resto del proyecto:
 *   listarBases_(forzar)            → [{id, alias, nombre, propiedades}]  (esquema compacto)
 *   verEsquema_(base, forzar)       → esquema detallado, con tipo de resultado de cada fórmula
 *   consultarBase_(base, filtro, orden, limite, propiedades) → filas normalizadas
 *   contarBase_(base, filtro)       → cantidad de filas que cumplen el filtro
 *   verPagina_(pageId)              → una página completa, con rollups/fórmulas sin truncar
 */

const CACHE_BASES = 'notion_bases_v2';
const CACHE_ESQUEMA = 'notion_esquema_v1_';
const LIMITE_DEFAULT = 50;
const LIMITE_MAX = 300;
const MAX_LLAMADAS_PAGINA = 15; // tope de llamadas extra de verPagina_

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** Llamada genérica a Notion con reintento ante rate limit (429) y errores 5xx. */
function notion_(method, path, body) {
  const opts = {
    method: method,
    headers: { Authorization: 'Bearer ' + prop_('NOTION_TOKEN', true), 'Notion-Version': NOTION_VERSION },
    contentType: 'application/json',
    muteHttpExceptions: true
  };
  if (body) opts.payload = JSON.stringify(body);

  for (let intento = 0; intento < 4; intento++) {
    const res = UrlFetchApp.fetch(NOTION_API + path, opts);
    const code = res.getResponseCode();
    if (code === 429 || code >= 500) {
      const espera = Number(res.getHeaders()['Retry-After']) || Math.pow(2, intento);
      Utilities.sleep(Math.min(espera, 10) * 1000);
      continue;
    }
    let data;
    try { data = JSON.parse(res.getContentText() || '{}'); } catch (e) { data = { message: res.getContentText().slice(0, 200) }; }
    if (code >= 400) throw errorNotion_(code, data);
    return data;
  }
  throw new Error('Notion no respondió después de varios intentos (límite de pedidos o caída). Probá de nuevo en un rato.');
}

/** Traduce los errores de Notion a mensajes claros. Los 400 de validación se dejan tal cual para que el modelo corrija el filtro. */
function errorNotion_(code, data) {
  let msg;
  if (code === 401) msg = 'El NOTION_TOKEN es inválido o fue revocado. Revisalo en Script Properties.';
  else if (code === 403) msg = 'La integración de Notion no tiene permiso para esto (¿le diste "Leer contenido"?).';
  else if (code === 404) msg = 'Notion no encuentra ese objeto: probablemente la base o página no está compartida con la integración (••• → Conexiones).';
  else msg = 'Notion ' + code + (data.code ? ' (' + data.code + ')' : '');
  const err = new Error(msg + (data.message ? ' Detalle: ' + data.message : ''));
  err.status = code;
  err.notionCode = data.code;
  return err;
}

/** Los ids de propiedad pueden venir ya URL-encoded ("a%3Fb"): se normalizan para no encodear dos veces. */
function encId_(id) {
  let dec = String(id);
  try { dec = decodeURIComponent(dec); } catch (e) { /* queda como vino */ }
  return encodeURIComponent(dec);
}

/** Agrega ?filter_properties[]=... a un path. */
function conPropiedades_(path, ids) {
  if (!ids || !ids.length) return path;
  return path + '?' + ids.map(function (id) { return 'filter_properties[]=' + encId_(id); }).join('&');
}

// ---------------------------------------------------------------------------
// Bases disponibles
// ---------------------------------------------------------------------------

/**
 * Devuelve las bases (data sources) que puede ver el agente, con esquema compacto.
 * Si está NOTION_DATA_SOURCES, solo esas (con su alias); si no, todas las compartidas con la integración.
 * Se cachea CACHE_TTL_SEG para no repetirlo en cada pregunta.
 */
function listarBases_(forzar) {
  const cache = CacheService.getScriptCache();
  if (!forzar) {
    const c = cache.get(CACHE_BASES);
    if (c) return JSON.parse(c);
  }
  const bases = [];
  const alias = notionDataSources_();

  if (alias) {
    Object.keys(alias).forEach(function (a) {
      try {
        const ds = obtenerDataSource_(alias[a]);
        bases.push({ id: ds.id, alias: a, nombre: textoPlano_(ds.title) || a, propiedades: esquemaCompacto_(ds.properties || {}) });
      } catch (e) {
        Logger.log('NOTION_DATA_SOURCES: no pude abrir "' + a + '": ' + e.message);
      }
    });
  } else {
    let cursor;
    do {
      const body = { filter: { property: 'object', value: 'data_source' }, page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const r = notion_('post', '/search', body);
      (r.results || []).forEach(function (ds) {
        if (ds.in_trash || ds.archived) return;
        if (!ds.properties) ds = notion_('get', '/data_sources/' + ds.id);
        bases.push({ id: ds.id, alias: null, nombre: textoPlano_(ds.title) || '(sin nombre)', propiedades: esquemaCompacto_(ds.properties || {}) });
      });
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor && bases.length < 300);
  }

  try { cache.put(CACHE_BASES, JSON.stringify(bases), CACHE_TTL_SEG); } catch (e) { /* muy grande para la caché */ }
  return bases;
}

/** Acepta un id de data source o de database (en ese caso usa su primer data source). */
function obtenerDataSource_(id) {
  try {
    return notion_('get', '/data_sources/' + id);
  } catch (e) {
    if (e.status !== 404 && e.status !== 400) throw e;
    const db = notion_('get', '/databases/' + id); // si tampoco es una database, sale el 404 original de acá
    const lista = db.data_sources || [];
    if (!lista.length) throw new Error('La base ' + id + ' no tiene data sources.');
    return notion_('get', '/data_sources/' + lista[0].id);
  }
}

/** Esquema compacto: { "Estado": "status: Pendiente | Pagado", "Monto": "number", "Total": "formula" } */
function esquemaCompacto_(props) {
  const out = {};
  Object.keys(props).forEach(function (nombre) {
    const p = props[nombre];
    let desc = p.type;
    const conf = p[p.type] || {};
    if ((p.type === 'select' || p.type === 'multi_select' || p.type === 'status') && conf.options) {
      desc += ': ' + conf.options.map(function (o) { return o.name; }).join(' | ');
    }
    out[nombre] = desc;
  });
  return out;
}

/** Busca la base por id, alias o nombre (sin distinguir mayúsculas ni acentos). */
function resolverBase_(base) {
  const norm = function (s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/-/g, '').trim(); };
  const objetivo = norm(base);
  if (!objetivo) throw new Error('Falta indicar la base.');
  const buscar = function (lista) {
    return lista.find(function (b) { return norm(b.id) === objetivo || norm(b.alias) === objetivo; }) ||
           lista.find(function (b) { return norm(b.nombre) === objetivo; }) ||
           lista.find(function (b) { return norm(b.nombre).indexOf(objetivo) >= 0; });
  };
  let ds = buscar(listarBases_());
  if (!ds) ds = buscar(listarBases_(true)); // por si se compartió una base nueva
  if (!ds) throw new Error('No encontré la base "' + base + '". ¿Está compartida con la integración' +
    (notionDataSources_() ? ' y listada en NOTION_DATA_SOURCES' : '') + '?');
  return ds;
}

// ---------------------------------------------------------------------------
// ver_esquema
// ---------------------------------------------------------------------------

/**
 * Esquema detallado de una base:
 * { data_source_id, titulo, propiedades: [{ nombre, id, tipo, opciones?, expresion?, tipo_resultado? }] }
 *
 * El esquema de Notion no dice de qué tipo es el resultado de una fórmula (string/number/boolean/date),
 * y eso es lo que hace falta para filtrar ({"formula":{"number":{...}}}). Se averigua leyendo una fila.
 * Se cachea CACHE_TTL_SEG por base.
 */
function verEsquema_(base, forzar) {
  const ds = resolverBase_(base);
  const cache = CacheService.getScriptCache();
  if (!forzar) {
    const c = cache.get(CACHE_ESQUEMA + ds.id);
    if (c) return JSON.parse(c);
  }
  const crudo = notion_('get', '/data_sources/' + ds.id);
  const props = crudo.properties || {};
  const nombrePorId = {};
  Object.keys(props).forEach(function (n) { nombrePorId[props[n].id] = n; });

  const lista = Object.keys(props).map(function (nombre) {
    const p = props[nombre];
    const conf = p[p.type] || {};
    const item = { nombre: nombre, id: p.id, tipo: p.type };
    if (conf.options) item.opciones = conf.options.map(function (o) { return o.name; });
    if (p.type === 'status' && conf.groups) {
      item.grupos = {};
      conf.groups.forEach(function (g) {
        item.grupos[g.name] = (g.option_ids || []).map(function (oid) {
          const op = (conf.options || []).find(function (o) { return o.id === oid; });
          return op ? op.name : oid;
        });
      });
    }
    if (p.type === 'formula') item.expresion = expresionLegible_(conf.expression, nombrePorId);
    if (p.type === 'rollup') {
      item.rollup = { relacion: conf.relation_property_name, propiedad: conf.rollup_property_name, funcion: conf['function'] };
    }
    if (p.type === 'relation' && conf.data_source_id) item.relacionada_con = conf.data_source_id;
    return item;
  });

  // Tipo de resultado de fórmulas y rollups: se lee de una fila de muestra (1 llamada, solo esas columnas).
  const calculadas = lista.filter(function (i) { return i.tipo === 'formula' || i.tipo === 'rollup'; });
  if (calculadas.length) {
    const r = notion_('post', conPropiedades_('/data_sources/' + ds.id + '/query', calculadas.map(function (i) { return i.id; })), { page_size: 1 });
    const fila = (r.results || [])[0];
    calculadas.forEach(function (i) {
      const v = fila && fila.properties && fila.properties[i.nombre];
      const tipo = v && v[i.tipo] && v[i.tipo].type;
      i.tipo_resultado = tipo ? (tipo === 'boolean' ? 'checkbox' : tipo) : 'desconocido (la base no tiene filas)';
    });
  }

  const out = { data_source_id: ds.id, titulo: ds.nombre, propiedades: lista };
  if (calculadas.some(function (i) { return i.tipo === 'formula'; })) {
    out.nota = 'Para filtrar una fórmula usá el tipo de resultado: {"property":"X","formula":{"<checkbox|number|string|date>":{...}}}';
  }
  try { cache.put(CACHE_ESQUEMA + ds.id, JSON.stringify(out), CACHE_TTL_SEG); } catch (e) { /* muy grande */ }
  return out;
}

/**
 * Notion devuelve las referencias como {{notion:block_property:<id>:...}}. Las pasa a prop("Nombre")
 * y recorta la expresión para no gastar tokens.
 */
function expresionLegible_(expr, nombrePorId) {
  if (!expr) return '';
  const legible = String(expr).replace(/\{\{notion:block_property:([^:}]+)[^}]*\}\}/g, function (m, id) {
    let dec = id;
    try { dec = decodeURIComponent(id); } catch (e) { /* queda como vino */ }
    const n = nombrePorId[id] || nombrePorId[dec];
    return n ? 'prop("' + n + '")' : m;
  });
  return legible.length > 300 ? legible.slice(0, 300) + '…' : legible;
}

// ---------------------------------------------------------------------------
// consultar_base
// ---------------------------------------------------------------------------

/**
 * Consulta una base y devuelve filas normalizadas.
 * @param {string} base         alias, nombre o id de la base
 * @param {Object} filtro       objeto "filter" de la API de Notion (opcional)
 * @param {Array}  orden        array "sorts" de la API de Notion (opcional)
 * @param {number} limite       máximo de filas (por defecto 50, tope 300); pagina internamente
 * @param {Array}  propiedades  nombres de columnas a traer (opcional; el título se agrega siempre)
 * @return {{base, data_source_id, cantidad, truncado, resultados}}
 */
function consultarBase_(base, filtro, orden, limite, propiedades) {
  const ds = resolverBase_(base);
  limite = Math.min(Math.max(Number(limite) || LIMITE_DEFAULT, 1), LIMITE_MAX);
  const path = conPropiedades_('/data_sources/' + ds.id + '/query', idsDePropiedades_(ds, propiedades));

  const filas = [];
  let cursor, hayMas = false;
  do {
    const body = { page_size: Math.min(100, limite - filas.length) };
    if (filtro && Object.keys(filtro).length) body.filter = filtro;
    if (orden && orden.length) body.sorts = orden;
    if (cursor) body.start_cursor = cursor;
    const r = notion_('post', path, body);
    (r.results || []).forEach(function (pg) {
      if (pg.in_trash || pg.archived) return;
      filas.push(normalizarPagina_(pg));
    });
    hayMas = !!r.has_more;
    cursor = hayMas ? r.next_cursor : null;
  } while (cursor && filas.length < limite);

  const out = { base: ds.nombre, data_source_id: ds.id, cantidad: filas.length, truncado: hayMas, resultados: filas };
  if (hayMas) out.aviso = 'Hay más filas que no se trajeron (límite ' + limite + '). Las sumas o conteos sobre estas filas son parciales.';
  return out;
}

/** Cuenta las filas que cumplen el filtro (hasta 1000) trayendo solo el título. */
function contarBase_(base, filtro) {
  const ds = resolverBase_(base);
  const titulo = Object.keys(ds.propiedades).filter(function (n) { return ds.propiedades[n] === 'title'; });
  const path = conPropiedades_('/data_sources/' + ds.id + '/query', idsDePropiedades_(ds, titulo));
  let total = 0, cursor, hayMas = false, paginas = 0;
  do {
    const body = { page_size: 100 };
    if (filtro && Object.keys(filtro).length) body.filter = filtro;
    if (cursor) body.start_cursor = cursor;
    const r = notion_('post', path, body);
    total += (r.results || []).filter(function (pg) { return !(pg.in_trash || pg.archived); }).length;
    hayMas = !!r.has_more;
    cursor = hayMas ? r.next_cursor : null;
  } while (cursor && ++paginas < 10);
  return { base: ds.nombre, data_source_id: ds.id, cantidad: total, truncado: hayMas };
}

/** Pasa nombres de columnas a ids de propiedad (para filter_properties[]). Agrega siempre el título. */
function idsDePropiedades_(ds, nombres) {
  if (!nombres || !nombres.length) return null;
  const esq = verEsquema_(ds.id);
  const porNombre = {};
  esq.propiedades.forEach(function (p) { porNombre[p.nombre.toLowerCase()] = p; });
  const desconocidas = [];
  const ids = [];
  nombres.forEach(function (n) {
    const p = porNombre[String(n).toLowerCase()];
    if (p) ids.push(p.id); else desconocidas.push(n);
  });
  if (desconocidas.length) {
    throw new Error('Propiedades que no existen en "' + ds.nombre + '": ' + desconocidas.join(', ') +
      '. Las válidas son: ' + esq.propiedades.map(function (p) { return p.nombre; }).join(', '));
  }
  esq.propiedades.forEach(function (p) { if (p.tipo === 'title' && ids.indexOf(p.id) < 0) ids.push(p.id); });
  return ids;
}

// ---------------------------------------------------------------------------
// ver_pagina
// ---------------------------------------------------------------------------

/**
 * Una página completa. Los rollups (y las fórmulas, si alguna relación vino cortada) se vuelven a pedir
 * con GET /pages/{id}/properties/{prop_id}, que pagina y devuelve el valor real.
 */
function verPagina_(pageId) {
  const id = String(pageId || '').replace(/^.*([0-9a-f]{32}).*$/i, '$1'); // acepta URL o id
  const pg = notion_('get', '/pages/' + id);
  const fila = normalizarPagina_(pg);
  const props = pg.properties || {};
  const nombres = Object.keys(props);

  const relacionCortada = nombres.some(function (n) { return props[n].type === 'relation' && props[n].has_more; });
  const aRevisar = nombres.filter(function (n) {
    const t = props[n].type;
    return t === 'rollup' || (t === 'relation' && props[n].has_more) || (t === 'formula' && relacionCortada);
  });

  let llamadas = 0;
  const incompletas = [];
  aRevisar.forEach(function (n) {
    if (!props[n].id) return;
    if (llamadas >= MAX_LLAMADAS_PAGINA) { incompletas.push(n); return; }
    const r = valorCompleto_(pg.id, props[n], MAX_LLAMADAS_PAGINA - llamadas);
    llamadas += r.llamadas;
    if (r.incompleto) incompletas.push(n);
    const vacio = r.valor === null || r.valor === undefined || r.valor === '' || (Array.isArray(r.valor) && !r.valor.length);
    if (vacio) delete fila[n]; else fila[n] = r.valor;
  });
  delete fila._incompletas;
  if (incompletas.length) fila._incompletas = incompletas; // ni con la API paginada se pudo traer todo
  return fila;
}

/** GET /pages/{id}/properties/{prop_id}, paginado. */
function valorCompleto_(pageId, prop, maxLlamadas) {
  const base = '/pages/' + pageId + '/properties/' + encId_(prop.id);
  let cursor, llamadas = 0, ultima = null;
  const items = [];
  do {
    const r = notion_('get', base + (cursor ? '?start_cursor=' + encodeURIComponent(cursor) : ''));
    llamadas++;
    if (r.object !== 'list') return { valor: valorPropiedad_(r), llamadas: llamadas, incompleto: false }; // fórmula, número, etc.
    (r.results || []).forEach(function (it) { items.push(it); });
    ultima = r;
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor && llamadas < maxLlamadas);

  const incompleto = !!cursor;
  if (prop.type === 'relation') {
    return { valor: items.length, llamadas: llamadas, incompleto: incompleto };
  }
  if (prop.type === 'rollup') {
    // El valor agregado viene en property_item.rollup. Si es un array, se arma con los items de cada página.
    const agg = ultima && ultima.property_item && ultima.property_item.rollup;
    if (agg && agg.type && agg.type !== 'array' && agg.type !== 'incomplete' && agg.type !== 'unsupported') {
      return { valor: valorPropiedad_({ type: 'rollup', rollup: agg }), llamadas: llamadas, incompleto: incompleto };
    }
    const valores = items.map(valorPropiedad_).filter(function (x) { return x !== null && x !== '' && x !== undefined; });
    return { valor: valores, llamadas: llamadas, incompleto: incompleto };
  }
  return { valor: items.map(valorPropiedad_), llamadas: llamadas, incompleto: incompleto };
}

// ---------------------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------------------

/** Página de Notion → objeto plano { id, url, "Nombre": "texto", "Total": 1234, ... } (sin vacíos). */
function normalizarPagina_(pg) {
  const out = { id: pg.id, url: pg.url };
  const incompletas = [];
  Object.keys(pg.properties || {}).forEach(function (nombre) {
    const p = pg.properties[nombre];
    if (p && p.type === 'relation' && p.has_more) incompletas.push(nombre);
    const v = valorPropiedad_(p);
    const vacio = v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
    if (!vacio) out[nombre] = v;
  });
  if (incompletas.length) out._incompletas = incompletas; // usar ver_pagina para el valor real
  return out;
}

/** Alias por compatibilidad. */
function simplificarPagina_(pg) { return normalizarPagina_(pg); }

/** Valor de una propiedad (o de un property_item) en formato simple. */
function valorPropiedad_(p) {
  if (!p) return null;
  const v = p[p.type];
  switch (p.type) {
    case 'title':
    case 'rich_text':        return Array.isArray(v) ? textoPlano_(v) : (v && v.plain_text) || '';
    case 'number':           return v;
    case 'checkbox':         return !!v;
    case 'select':
    case 'status':           return v ? v.name : null;
    case 'multi_select':     return (v || []).map(function (o) { return o.name; });
    case 'date':             return fecha_(v);
    case 'people':           return Array.isArray(v) ? v.map(nombrePersona_) : nombrePersona_(v);
    case 'relation':         return Array.isArray(v) ? v.length : (v && v.id) || null;
    case 'url':
    case 'email':
    case 'phone_number':     return v;
    case 'files':            return (v || []).map(function (f) { return f.name; });
    case 'created_time':
    case 'last_edited_time': return v;
    case 'created_by':
    case 'last_edited_by':   return nombrePersona_(v);
    case 'unique_id':        return v ? (v.prefix ? v.prefix + '-' : '') + v.number : null;
    case 'formula':
      if (!v) return null;
      if (v.type === 'date') return fecha_(v.date);
      return v[v.type] === undefined ? null : v[v.type]; // string / number / boolean
    case 'rollup':
      if (!v) return null;
      if (v.type === 'array') return (v.array || []).map(valorPropiedad_).filter(function (x) { return x !== null && x !== ''; });
      if (v.type === 'date') return fecha_(v.date);
      return v[v.type] === undefined ? null : v[v.type];
    case 'verification':     return v && v.state;
    default:                 return null;
  }
}

function nombrePersona_(u) {
  return u ? (u.name || 'usuario') : null;
}

function textoPlano_(rt) {
  return (rt || []).map(function (t) { return t.plain_text; }).join('').trim();
}

/** Fecha → "2026-11-01", o { inicio, fin } si es un rango. */
function fecha_(d) {
  if (!d || !d.start) return null;
  return d.end ? { inicio: d.start, fin: d.end } : d.start;
}

// ---------------------------------------------------------------------------
// Pruebas desde el editor
// ---------------------------------------------------------------------------

/** Ejecutala desde el editor: lista bases, muestra el esquema de la primera y trae 3 filas. */
function probarNotion() {
  const bases = listarBases_(true);
  Logger.log('Bases encontradas: ' + bases.length);
  bases.forEach(function (b) { Logger.log((b.alias ? '[' + b.alias + '] ' : '') + b.nombre + ' (' + b.id + ')'); });
  if (!bases.length) return;

  const esq = verEsquema_(bases[0].id, true);
  Logger.log('Esquema de "' + esq.titulo + '":');
  esq.propiedades.forEach(function (p) {
    Logger.log('  ' + p.nombre + ': ' + p.tipo +
      (p.tipo_resultado ? ' → ' + p.tipo_resultado : '') +
      (p.opciones ? ' [' + p.opciones.join(' | ') + ']' : '') +
      (p.expresion ? '  = ' + p.expresion : ''));
  });

  const filas = consultarBase_(bases[0].id, null, null, 3);
  Logger.log('Primeras filas: ' + JSON.stringify(filas));
  if (filas.resultados.length) Logger.log('ver_pagina de la primera: ' + JSON.stringify(verPagina_(filas.resultados[0].id)));
}

/**
 * Prueba de filtro por fórmula. Cambiá los valores y ejecutala desde el editor, por ejemplo:
 *   base 'Tareas', propiedad 'Atrasada' (fórmula checkbox) → {"formula":{"checkbox":{"equals":true}}}
 */
function probarFiltroFormula() {
  const BASE = 'Tareas';
  const PROPIEDAD = 'Atrasada';
  const esq = verEsquema_(BASE);
  const p = esq.propiedades.find(function (x) { return x.nombre === PROPIEDAD; });
  if (!p || p.tipo !== 'formula') throw new Error('"' + PROPIEDAD + '" no es una fórmula de "' + esq.titulo + '".');
  const condicion = {
    checkbox: { equals: true },
    number: { greater_than: 0 },
    string: { is_not_empty: true },
    date: { on_or_after: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd') }
  }[p.tipo_resultado];
  if (!condicion) throw new Error('No sé el tipo de resultado de "' + PROPIEDAD + '": ' + p.tipo_resultado);
  const filtro = { property: PROPIEDAD, formula: {} };
  filtro.formula[p.tipo_resultado] = condicion;
  Logger.log('Filtro: ' + JSON.stringify(filtro));
  Logger.log('Cantidad: ' + JSON.stringify(contarBase_(BASE, filtro)));
  Logger.log('Filas: ' + JSON.stringify(consultarBase_(BASE, filtro, null, 5, [PROPIEDAD])));
}
