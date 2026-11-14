/**
 * Herramientas del agente: definición (JSON schema) + dispatcher.
 * Las usan Claude (Agent.gs) y Gemini (Gemini.gs); para Gemini, los parámetros objeto/array
 * se declaran como texto JSON (su esquema no acepta bien objetos libres) y acá se parsean.
 */

const MAX_CHARS_RESULTADO = 60000; // ~15k tokens: si una consulta trae más, se recorta y se avisa

const TOOLS = [
  {
    name: 'listar_bases',
    description: 'Lista las bases de Notion disponibles: alias, data_source_id y título. Usala solo si el listado del primer mensaje no alcanza (por ejemplo, si el usuario dice que compartió una base nueva).',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'ver_esquema',
    description: 'Devuelve las propiedades (columnas) de una base: nombre, tipo, opciones válidas de select/status, y para fórmulas y rollups la expresión y el TIPO DE RESULTADO (checkbox, number, string o date), que es el que hay que usar para filtrarlas. Llamala antes de la primera consulta a cada base.',
    input_schema: {
      type: 'object',
      properties: {
        data_source_id: { type: 'string', description: 'data_source_id, alias o título de la base.' }
      },
      required: ['data_source_id']
    }
  },
  {
    name: 'consultar_base',
    description: 'Consulta una base con filtro y orden en el formato nativo de la API de Notion (el filtro se aplica en Notion, no hace falta traer todo). Devuelve filas planas {id, url, propiedad: valor}, cantidad y truncado (true si quedaron filas sin traer). Con solo_contar=true devuelve solo la cantidad (hasta 1000).',
    input_schema: {
      type: 'object',
      properties: {
        data_source_id: { type: 'string', description: 'data_source_id, alias o título de la base.' },
        filter: { type: 'object', description: 'Objeto "filter" de la API de Notion (opcional).' },
        sorts: { type: 'array', items: { type: 'object' }, description: 'Array "sorts" de la API de Notion (opcional).' },
        propiedades: { type: 'array', items: { type: 'string' }, description: 'Nombres exactos de las columnas a traer (opcional; el título viene siempre). Pedí solo las que necesitás para responder.' },
        limite: { type: 'integer', description: 'Máximo de filas (por defecto 50, máximo 300).' },
        solo_contar: { type: 'boolean', description: 'true para devolver solo la cantidad de filas que cumplen el filtro.' }
      },
      required: ['data_source_id']
    }
  },
  {
    name: 'guardar_registro',
    description: 'Crea un registro nuevo en una base (con data_source_id) o modifica uno existente (con page_id, solo las columnas que cambian). Funciona en dos pasos: SIN token valida, avisa qué falta (faltan, errores) y devuelve un resumen y un token, sin guardar nada. CON el token (después de que el usuario confirmó en otro mensaje) guarda en Notion. Valores simples: texto, número, nombre de la opción en select/status, fecha AAAA-MM-DD o AAAA-MM-DDTHH:MM (o {inicio, fin}), true/false, y en relaciones el nombre o id del registro relacionado.',
    input_schema: {
      type: 'object',
      properties: {
        data_source_id: { type: 'string', description: 'Base donde crear (id, alias o título). No hace falta si se modifica con page_id.' },
        page_id: { type: 'string', description: 'id o URL del registro a modificar. Vacío para crear uno nuevo.' },
        propiedades: { type: 'object', description: 'Objeto {"Columna": valor} con los nombres exactos de las columnas.' },
        token: { type: 'string', description: 'Token del resumen, solo cuando el usuario ya confirmó. Las propiedades tienen que ser las mismas del resumen.' }
      },
      required: ['propiedades']
    }
  },
  {
    name: 'ver_pagina',
    description: 'Devuelve todas las propiedades de una página (fila) por su id o URL, con el valor real de rollups y fórmulas que en consultar_base vienen incompletos (marcados en _incompletas).',
    input_schema: {
      type: 'object',
      properties: {
        page_id: { type: 'string', description: 'id o URL de la página.' }
      },
      required: ['page_id']
    }
  }
];

/** Ejecuta una herramienta. Los errores se propagan: el loop los devuelve al modelo como is_error. */
function ejecutarHerramienta_(nombre, input) {
  input = input || {};
  switch (nombre) {
    case 'listar_bases':
      return listarBasesAgente_(true);
    case 'ver_esquema':
      return verEsquema_(input.data_source_id);
    case 'consultar_base': {
      const filtro = parseJson_(input.filter, 'filter');
      if (input.solo_contar) return contarBase_(input.data_source_id, filtro);
      const r = consultarBase_(input.data_source_id, filtro, parseJson_(input.sorts, 'sorts'),
        input.limite, parseJson_(input.propiedades, 'propiedades'));
      return recortarResultado_(r);
    }
    case 'ver_pagina':
      return verPagina_(input.page_id);
    case 'guardar_registro':
      return guardarRegistro_(input);
    default:
      throw new Error('Herramienta desconocida: ' + nombre);
  }
}

/** Listado mínimo de bases para el agente: [{alias, data_source_id, titulo}]. */
function listarBasesAgente_(forzar) {
  return listarBases_(forzar).map(function (b) {
    const o = { data_source_id: b.id, titulo: b.nombre };
    if (b.alias) o.alias = b.alias;
    const sis = configDeBase_(b.nombre, b.id);
    if (sis) o.sistema = sis.sistema;
    return o;
  });
}

/** Acepta objeto/array o texto JSON (Gemini); vacío → null. */
function parseJson_(v, campo) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { throw new Error(campo + ' no es JSON válido: ' + e.message); }
}

/** Si el resultado es demasiado grande para el modelo, recorta filas y avisa. */
function recortarResultado_(r) {
  if (JSON.stringify(r).length <= MAX_CHARS_RESULTADO) return r;
  const filas = r.resultados;
  let n = filas.length;
  while (n > 1 && JSON.stringify(filas.slice(0, n)).length > MAX_CHARS_RESULTADO) n = Math.floor(n * 0.8);
  r.resultados = filas.slice(0, n);
  r.cantidad_devuelta = n;
  r.truncado = true;
  r.aviso = 'Se trajeron ' + filas.length + ' filas pero solo entran ' + n + ' en la respuesta. ' +
    'Usá "propiedades" para pedir menos columnas, un filtro más específico o solo_contar.';
  return r;
}

/** Declaraciones para Gemini: mismos nombres, objetos/arrays como texto JSON. */
function herramientasGemini_() {
  return [{
    functionDeclarations: TOOLS.map(function (t) {
      const props = t.input_schema.properties;
      const d = { name: t.name, description: t.description };
      if (!Object.keys(props).length) return d;
      const out = {};
      Object.keys(props).forEach(function (k) {
        const p = props[k];
        out[k] = (p.type === 'object' || p.type === 'array')
          ? { type: 'string', description: p.description + ' Escribilo como texto JSON.' }
          : { type: p.type, description: p.description };
      });
      d.parameters = { type: 'object', properties: out, required: t.input_schema.required };
      return d;
    })
  }];
}
