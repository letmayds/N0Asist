/**
 * Conexión con la API oficial de Notion.
 *
 * Versión de API: 2026-03-11. Desde 2025-09-03 las bases ("databases") son contenedores
 * de uno o más "data sources"; las consultas y los esquemas se hacen sobre el data source:
 *   POST /v1/search                     (filter.value = "data_source")
 *   GET  /v1/data_sources/{id}
 *   POST /v1/data_sources/{id}/query
 *
 * El token de la integración va en Script Properties como NOTION_TOKEN.
 */

const NOTION_VERSION = '2026-03-11';
const NOTION_API = 'https://api.notion.com/v1';
const CACHE_BASES = 'notion_bases_v1';

/** Llamada genérica a Notion con reintento ante rate limit (429) y errores 5xx. */
function notion_(method, path, body) {
  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) throw new Error('Falta NOTION_TOKEN en Script Properties.');
  const opts = {
    method: method,
    headers: { Authorization: 'Bearer ' + token, 'Notion-Version': NOTION_VERSION },
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
    const data = JSON.parse(res.getContentText() || '{}');
    if (code >= 400) throw new Error('Notion ' + code + ' (' + data.code + '): ' + data.message);
    return data;
  }
  throw new Error('Notion no respondió después de varios intentos.');
}

// ---------------------------------------------------------------------------
// listar_bases
// ---------------------------------------------------------------------------

/**
 * Devuelve las bases (data sources) compartidas con la integración y su esquema resumido.
 * Se cachea 10 minutos para no repetir la búsqueda en cada pregunta.
 */
function listarBases_(forzar) {
  const cache = CacheService.getScriptCache();
  if (!forzar) {
    const c = cache.get(CACHE_BASES);
    if (c) return JSON.parse(c);
  }
  const bases = [];
  let cursor;
  do {
    const body = { filter: { property: 'object', value: 'data_source' }, page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = notion_('post', '/search', body);
    (r.results || []).forEach(function (ds) {
      if (ds.in_trash || ds.archived) return;
      let props = ds.properties;
      if (!props) props = notion_('get', '/data_sources/' + ds.id).properties || {};
      bases.push({ id: ds.id, nombre: textoPlano_(ds.title) || '(sin nombre)', propiedades: esquema_(props) });
    });
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor && bases.length < 300);

  try { cache.put(CACHE_BASES, JSON.stringify(bases), 600); } catch (e) { /* muy grande para la caché */ }
  return bases;
}

/** Esquema compacto: { "Estado": "status: Pendiente | Pagado", "Monto": "number", ... } */
function esquema_(props) {
  const out = {};
  Object.keys(props).forEach(function (nombre) {
    const p = props[nombre];
    let desc = p.type;
    const conf = p[p.type] || {};
    if ((p.type === 'select' || p.type === 'multi_select' || p.type === 'status') && conf.options) {
      desc += ': ' + conf.options.map(function (o) { return o.name; }).join(' | ');
    }
    if (p.type === 'formula' && conf.expression) desc += ' (fórmula)';
    out[nombre] = desc;
  });
  return out;
}

// ---------------------------------------------------------------------------
// consultar_base
// ---------------------------------------------------------------------------

/**
 * Consulta una base.
 * @param {string} base     nombre o id de la base
 * @param {Object} filtro   objeto "filter" de la API de Notion (opcional)
 * @param {Array}  orden    array "sorts" de la API de Notion (opcional)
 * @param {number} limite   máximo de filas a devolver (por defecto 50, tope 200)
 */
function consultarBase_(base, filtro, orden, limite) {
  const ds = resolverBase_(base);
  limite = Math.min(Math.max(Number(limite) || 50, 1), 200);

  const filas = [];
  let cursor, hayMas = false;
  do {
    const body = { page_size: Math.min(100, limite - filas.length) };
    if (filtro && Object.keys(filtro).length) body.filter = filtro;
    if (orden && orden.length) body.sorts = orden;
    if (cursor) body.start_cursor = cursor;
    const r = notion_('post', '/data_sources/' + ds.id + '/query', body);
    (r.results || []).forEach(function (pg) {
      if (pg.in_trash || pg.archived) return;
      filas.push(simplificarPagina_(pg));
    });
    hayMas = !!r.has_more;
    cursor = hayMas ? r.next_cursor : null;
  } while (cursor && filas.length < limite);

  return { base: ds.nombre, cantidad: filas.length, hay_mas: hayMas, resultados: filas };
}

/** Busca la base por id o por nombre (sin distinguir mayúsculas ni acentos). */
function resolverBase_(base) {
  const norm = function (s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/-/g, '').trim(); };
  const objetivo = norm(base);
  const buscar = function (lista) {
    return lista.find(function (b) { return norm(b.id) === objetivo; }) ||
           lista.find(function (b) { return norm(b.nombre) === objetivo; }) ||
           lista.find(function (b) { return norm(b.nombre).indexOf(objetivo) >= 0; });
  };
  let ds = buscar(listarBases_());
  if (!ds) ds = buscar(listarBases_(true)); // por si se compartió una base nueva
  if (!ds) throw new Error('No encontré la base "' + base + '". ¿Está compartida con la integración?');
  return ds;
}

/** Convierte una página de Notion en { propiedad: valor } legible, sin el JSON crudo. */
function simplificarPagina_(pg) {
  const out = {};
  Object.keys(pg.properties || {}).forEach(function (nombre) {
    const v = valorPropiedad_(pg.properties[nombre]);
    const vacio = v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
    if (!vacio) out[nombre] = v;
  });
  return out;
}

function valorPropiedad_(p) {
  if (!p) return null;
  const v = p[p.type];
  switch (p.type) {
    case 'title':
    case 'rich_text':        return textoPlano_(v);
    case 'number':           return v;
    case 'checkbox':         return v ? 'sí' : 'no';
    case 'select':
    case 'status':           return v ? v.name : null;
    case 'multi_select':     return (v || []).map(function (o) { return o.name; });
    case 'date':             return fecha_(v);
    case 'people':           return (v || []).map(function (u) { return u.name || 'usuario'; });
    case 'relation':         return (v || []).length ? (v.length + ' vinculado(s)') : null;
    case 'url':
    case 'email':
    case 'phone_number':     return v;
    case 'files':            return (v || []).map(function (f) { return f.name; });
    case 'created_time':
    case 'last_edited_time': return v;
    case 'created_by':
    case 'last_edited_by':   return v && v.name;
    case 'unique_id':        return v ? (v.prefix ? v.prefix + '-' : '') + v.number : null;
    case 'formula':          return v ? (v.type === 'date' ? fecha_(v.date) : v[v.type]) : null;
    case 'rollup':
      if (!v) return null;
      if (v.type === 'array') return (v.array || []).map(valorPropiedad_).filter(function (x) { return x !== null && x !== ''; });
      if (v.type === 'date') return fecha_(v.date);
      return v[v.type];
    case 'verification':     return v && v.state;
    default:                 return null;
  }
}

function textoPlano_(rt) {
  return (rt || []).map(function (t) { return t.plain_text; }).join('').trim();
}

function fecha_(d) {
  if (!d || !d.start) return null;
  return d.end ? d.start + ' a ' + d.end : d.start;
}

// ---------------------------------------------------------------------------
// Prueba desde el editor
// ---------------------------------------------------------------------------

/** Ejecutala desde el editor para ver qué bases encuentra la integración. */
function probarNotion() {
  const bases = listarBases_(true);
  Logger.log('Bases encontradas: ' + bases.length);
  bases.forEach(function (b) { Logger.log(b.nombre + ' → ' + JSON.stringify(b.propiedades)); });
  if (bases.length) Logger.log('Primeras filas de "' + bases[0].nombre + '": ' + JSON.stringify(consultarBase_(bases[0].id, null, null, 3)));
}
