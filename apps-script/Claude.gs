/**
 * Claude (Messages API) con tool use sobre Notion.
 *
 * - API key en Script Properties: ANTHROPIC_API_KEY.
 * - Modelo: claude-haiku-5-5 por defecto; se puede pedir claude-sonnet-5-5.
 * - El historial se maneja "append-only": el frontend devuelve tal cual los mensajes
 *   (incluidos bloques thinking / tool_use / tool_result) y acá solo se agregan turnos nuevos.
 *   El system prompt y las tools no cambian durante la conversación (requisito de los
 *   bloques de pensamiento y además mejora el prompt caching). Por eso la fecha va en el
 *   mensaje del usuario y no en el system prompt.
 */

// ANTHROPIC_URL, ANTHROPIC_VERSION, MODELOS y MODELO_DEFAULT están en Config.gs
const MAX_VUELTAS_TOOLS = 8;

const SYSTEM_PROMPT = [
  'Sos un asistente de voz que responde preguntas sobre las bases de datos de Notion del usuario.',
  'Tus respuestas se leen en voz alta con un sintetizador, así que:',
  '- Hablá en español rioplatense (voseo), con tono natural y cercano.',
  '- Sé breve: una a tres oraciones en general. Nada de markdown, listas, viñetas, tablas, emojis, asteriscos ni URLs.',
  '- Escribí los números y las fechas como se dicen ("el martes 18 de noviembre", "mil quinientos pesos").',
  '- Si hay muchos resultados, resumí (cantidad y lo más importante) y ofrecé detallar.',
  '',
  'Sobre los datos:',
  '- Usá siempre las herramientas para responder; nunca inventes datos. Si no encontrás algo en Notion, decilo.',
  '- Cada mensaje del usuario empieza con la fecha y hora actual entre corchetes; usala para interpretar "hoy", "esta semana", "el mes que viene", etc.',
  '- El primer mensaje de la conversación trae el listado de bases con sus propiedades. Si necesitás refrescarlo, usá listar_bases.',
  '- Para consultar_base armá el filtro con la sintaxis de filtros de la API de Notion, usando los nombres exactos de las propiedades y, en select/status, los valores exactos de las opciones. Ejemplos:',
  '  {"property":"Estado","status":{"equals":"Pendiente"}}',
  '  {"property":"Monto","number":{"greater_than":1000}}',
  '  {"property":"Cliente","title":{"contains":"Pérez"}}',
  '  {"property":"Pagado","checkbox":{"equals":true}}',
  '  {"property":"Vence","date":{"on_or_after":"2026-11-17"}}',
  '  {"and":[filtro1, filtro2]} o {"or":[...]}',
  '- Orden: [{"property":"Vence","direction":"ascending"}].',
  '- Para preguntas de "cuántos" usá solo_contar=true.',
  '- Si una consulta falla por un filtro mal armado, corregilo y probá de nuevo antes de rendirte.',
  '- En preguntas de seguimiento ("¿y de esos, cuáles pagaron?") reutilizá el contexto de la conversación.'
].join('\n');

const TOOLS = [
  {
    name: 'listar_bases',
    description: 'Devuelve las bases de Notion disponibles con su id, nombre y propiedades (tipo y, para select/status/multi_select, las opciones válidas).',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'consultar_base',
    description: 'Consulta una base de Notion y devuelve las filas simplificadas (propiedad: valor). Devuelve también cantidad y truncado (true si quedaron filas sin traer).',
    input_schema: {
      type: 'object',
      properties: {
        base: { type: 'string', description: 'Nombre o id de la base.' },
        filtro: { type: 'object', description: 'Objeto "filter" de la API de Notion (opcional).' },
        orden: {
          type: 'array',
          description: 'Array "sorts" de la API de Notion (opcional).',
          items: { type: 'object' }
        },
        limite: { type: 'integer', description: 'Máximo de filas a traer (1 a 200, por defecto 50).' },
        solo_contar: { type: 'boolean', description: 'Si es true, devuelve solo la cantidad de filas que cumplen el filtro (hasta 1000), sin los datos.' }
      },
      required: ['base']
    }
  }
];

/**
 * Procesa una pregunta.
 * @param {string} texto     lo que dijo el usuario
 * @param {Array}  historial mensajes previos tal como los devolvió esta función
 * @param {string} modelo    id del modelo (opcional)
 * @return {{respuesta:string, historial:Array, herramientas:Array, modelo:string}}
 */
function preguntar_(texto, historial, modelo) {
  modelo = MODELOS[modelo] ? modelo : MODELO_DEFAULT;
  const mensajes = Array.isArray(historial) ? historial.slice() : [];
  const ahora = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "EEEE yyyy-MM-dd HH:mm");

  const contenido = [];
  if (!mensajes.length) {
    // Primer turno: le pasamos las bases para ahorrar una vuelta de herramienta.
    contenido.push({ type: 'text', text: 'Bases disponibles: ' + JSON.stringify(listarBasesParaClaude_()) });
  }
  contenido.push({ type: 'text', text: '[' + ahora + '] ' + String(texto || '').trim() });
  mensajes.push({ role: 'user', content: contenido });

  const usadas = [];
  for (let vuelta = 0; vuelta < MAX_VUELTAS_TOOLS; vuelta++) {
    const res = llamarClaude_(modelo, mensajes);

    if (res.stop_reason === 'refusal') {
      // No se agrega nada al historial: el turno se descarta.
      return { respuesta: 'Perdón, esa pregunta no la puedo responder. Probá reformularla.', historial: historial || [], herramientas: usadas, modelo: res.model || modelo };
    }

    mensajes.push({ role: 'assistant', content: res.content });

    const pedidos = res.content.filter(function (b) { return b.type === 'tool_use'; });
    if (res.stop_reason !== 'tool_use' || !pedidos.length) {
      let txt = res.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join(' ').trim();
      if (res.stop_reason === 'max_tokens') txt += ' (La respuesta quedó cortada.)';
      return { respuesta: txt || 'No tengo una respuesta para eso.', historial: mensajes, herramientas: usadas, modelo: res.model || modelo };
    }

    // Ejecutar todas las herramientas pedidas y devolver todos los resultados en un solo mensaje.
    const resultados = pedidos.map(function (p) {
      usadas.push({ nombre: p.name, input: p.input });
      try {
        return { type: 'tool_result', tool_use_id: p.id, content: JSON.stringify(ejecutarHerramienta_(p.name, p.input || {})) };
      } catch (err) {
        return { type: 'tool_result', tool_use_id: p.id, content: 'Error: ' + (err && err.message || err), is_error: true };
      }
    });
    mensajes.push({ role: 'user', content: resultados });
  }
  return { respuesta: 'Me enredé consultando Notion. ¿Me lo preguntás de otra forma?', historial: mensajes, herramientas: usadas, modelo: modelo };
}

function ejecutarHerramienta_(nombre, input) {
  switch (nombre) {
    case 'listar_bases':
      return listarBasesParaClaude_(true);
    case 'consultar_base':
      if (input.solo_contar) return contarBase_(input.base, input.filtro);
      return consultarBase_(input.base, input.filtro, input.orden, input.limite);
    default:
      throw new Error('Herramienta desconocida: ' + nombre);
  }
}

function listarBasesParaClaude_(forzar) {
  return listarBases_(forzar).map(function (b) { return { id: b.id, alias: b.alias, nombre: b.nombre, propiedades: b.propiedades }; });
}

/** POST /v1/messages con reintentos ante 429 / 5xx / 529 (sobrecarga). */
function llamarClaude_(modelo, mensajes) {
  const key = prop_('ANTHROPIC_API_KEY', true);
  const conf = MODELOS[modelo];

  const body = {
    model: modelo,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages: mensajes,
    output_config: { effort: conf.effort },
    cache_control: { type: 'ephemeral' } // caching automático del prefijo (system + tools + historial)
  };
  const headers = { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION };
  if (conf.fallback) {
    // Sonnet 5.5: si un clasificador de seguridad rechaza el pedido, el servidor reintenta con otro modelo.
    body.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }

  let ultimoError = '';
  for (let intento = 0; intento < 4; intento++) {
    const r = UrlFetchApp.fetch(ANTHROPIC_URL, {
      method: 'post', contentType: 'application/json', headers: headers,
      payload: JSON.stringify(body), muteHttpExceptions: true
    });
    const code = r.getResponseCode();
    const data = JSON.parse(r.getContentText() || '{}');
    if (code === 200) return data;
    ultimoError = 'Claude ' + code + ': ' + (data.error && data.error.message || r.getContentText().slice(0, 200));
    if (code === 429 || code === 529 || code >= 500) {
      const espera = Number(r.getHeaders()['retry-after'] || r.getHeaders()['Retry-After']) || Math.pow(2, intento);
      Utilities.sleep(Math.min(espera, 15) * 1000);
      continue;
    }
    throw new Error(ultimoError); // 400/401/403/404: no tiene sentido reintentar
  }
  throw new Error(ultimoError);
}

/** Ejecutala desde el editor para probar Claude + Notion sin el frontend. */
function probarClaude() {
  const r1 = preguntar_('¿Qué bases tengo y para qué sirve cada una?', [], MODELO_DEFAULT);
  Logger.log('Respuesta: ' + r1.respuesta);
  Logger.log('Herramientas: ' + JSON.stringify(r1.herramientas));
}
