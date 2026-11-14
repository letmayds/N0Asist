/**
 * Agente: Claude (Messages API) con tool use sobre Notion.
 *
 * - Herramientas y dispatcher en Tools.gs; cliente de Notion en Notion.gs; modelos en Config.gs.
 * - Ciclo: messages + tools → si stop_reason es "tool_use", se ejecutan todas las herramientas pedidas,
 *   se devuelven los tool_result (errores con is_error, p. ej. un 400 de filtro mal armado) y se repite.
 * - El historial se maneja "append-only": el frontend devuelve tal cual los mensajes
 *   (incluidos bloques thinking / tool_use / tool_result) y acá solo se agregan turnos nuevos.
 *   El system prompt y las tools no cambian durante la conversación (requisito de los bloques de
 *   pensamiento y además aprovecha el prompt caching). Por eso la fecha actual va en cada mensaje
 *   del usuario y la lista de bases en el primero, en lugar del system prompt.
 */

const MAX_VUELTAS_TOOLS = 6;

/** System prompt. Es una función (y no un const) porque usa NOTAS_NEGOCIO de Config.gs, y Apps Script puede cargar los archivos en cualquier orden. */
function systemPrompt_() {
  return [
  'Sos un asistente de voz que responde preguntas sobre las bases de datos de Notion del usuario.',
  'Tus respuestas se leen en voz alta con un sintetizador, así que:',
  '- Hablá en español rioplatense (voseo), con tono natural y cercano.',
  '- Sé breve: una a tres oraciones en general. Nada de markdown, listas, viñetas, tablas, emojis, asteriscos ni URLs.',
  '- Redondeá y escribí los números y las fechas como se dicen ("unos ciento veinte mil pesos", "el martes 18 de noviembre"). Un porcentaje guardado como 0.4 es "cuarenta por ciento".',
  '- Si hay muchos resultados, resumí (cantidad y lo más importante) y ofrecé detallar.',
  '',
  'Cómo consultar:',
  '- Usá siempre las herramientas; nunca inventes datos. Si algo no está en Notion, decilo.',
  '- Cada mensaje del usuario empieza con la fecha y hora actual (zona Buenos Aires) entre corchetes; usala para "hoy", "esta semana", "noviembre", etc.',
  '- El primer mensaje trae la lista de bases (alias, data_source_id, título). No hace falta llamar a listar_bases salvo que falte alguna.',
  '- Si una propiedad trae "descripcion" en ver_esquema, tomala como la definición de esa columna.',
  '- SIEMPRE llamá a ver_esquema antes de la primera consulta a una base en la conversación (si ya lo hiciste antes en esta charla, no repitas). Usá los nombres exactos de propiedades y opciones que devuelve.',
  '- Filtrá en Notion con el parámetro filter, no traigas todo para filtrar a mano. Formato según el tipo de la propiedad:',
  '  {"property":"Estado","status":{"equals":"Confirmado"}}   {"property":"Turno","select":{"equals":"Noche"}}',
  '  {"property":"Invitados","number":{"greater_than":100}}   {"property":"Evento","title":{"contains":"Romina"}}',
  '  {"property":"Fecha","date":{"on_or_after":"2026-11-01"}}  (también before, after, on_or_before, equals, is_empty, next_week, this_week…)',
  '  {"and":[filtro1, filtro2]}  o  {"or":[...]}',
  '- FÓRMULAS: el filtro usa el TIPO DE RESULTADO que da ver_esquema (tipo_resultado), no "formula" solo:',
  '  {"property":"Atrasada","formula":{"checkbox":{"equals":true}}}',
  '  {"property":"Margen","formula":{"number":{"greater_than":0.3}}}',
  '  {"property":"Situación","formula":{"string":{"contains":"Pagado"}}}',
  '  {"property":"Límite seña","formula":{"date":{"before":"2026-12-01"}}}',
  '- ROLLUPS numéricos o de fecha: {"property":"Total pagado","rollup":{"number":{"greater_than":0}}}; de lista: {"rollup":{"any":{...}}}.',
  '- Orden: [{"property":"Fecha","direction":"ascending"}] o [{"timestamp":"created_time","direction":"descending"}].',
  '- Pedí solo las columnas necesarias con "propiedades" y un "limite" razonable.',
  '- Para "¿cuántos…?" usá solo_contar=true. Para sumas o promedios, calculá sobre las filas devueltas; si truncado es true, avisá que el resultado es parcial.',
  '- Si una fila trae _incompletas, o piden el detalle de una fila, usá ver_pagina.',
  '- Si Notion devuelve un error de validación, leé el mensaje, corregí el filtro y probá de nuevo.',
  '- En preguntas de seguimiento ("¿y de esos, cuáles son de noviembre?") reutilizá el filtro anterior agregando la condición nueva con "and".'
].join('\n') + (NOTAS_NEGOCIO ? '\n\nNotas sobre los datos del usuario:\n' + NOTAS_NEGOCIO : '');
}

function preguntar_(texto, historial, modelo) {
  modelo = MODELOS[modelo] ? modelo : MODELO_DEFAULT;
  const mensajes = Array.isArray(historial) ? historial.slice() : [];
  const ahora = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "EEEE yyyy-MM-dd HH:mm");

  const contenido = [];
  if (!mensajes.length) {
    // Primer turno: le pasamos las bases para ahorrar una vuelta de herramienta.
    contenido.push({ type: 'text', text: 'Bases disponibles: ' + JSON.stringify(listarBasesAgente_()) });
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

/** POST /v1/messages con reintentos ante 429 / 5xx / 529 (sobrecarga). */
function llamarClaude_(modelo, mensajes) {
  const key = prop_('ANTHROPIC_API_KEY', true);
  const conf = MODELOS[modelo];

  const body = {
    model: modelo,
    max_tokens: 16000,
    system: systemPrompt_(),
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

/** Desde el editor: una pregunta y una de seguimiento, sin el frontend. Muestra herramientas, datos y tiempos. */
function probarAgente() {
  const PREGUNTAS = [
    'De los eventos de diciembre, ¿a alguno le falta pagar algo? ¿Cuánto?',
    '¿Y cuánto suman entre todos?'
  ];
  let historial = [];
  PREGUNTAS.forEach(function (q) {
    const t = Date.now();
    const r = preguntar_(q, historial, MODELO_DEFAULT);
    const nuevos = r.historial.slice(historial.length);
    historial = r.historial;
    Logger.log('P: ' + q);
    nuevos.forEach(function (m) {
      (Array.isArray(m.content) ? m.content : []).forEach(function (b) {
        if (b.type === 'tool_use') Logger.log('  → ' + b.name + ' ' + JSON.stringify(b.input));
        if (b.type === 'tool_result') Logger.log('  ← ' + (b.is_error ? 'ERROR ' : '') + String(b.content).slice(0, 600));
      });
    });
    Logger.log('R: ' + r.respuesta);
    Logger.log('Tiempo: ' + ((Date.now() - t) / 1000).toFixed(1) + ' s');
  });
}
