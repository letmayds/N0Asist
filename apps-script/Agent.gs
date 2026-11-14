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

/** System prompt. Es una función (y no un const) porque usa las notas de los archivos Sistema_*.gs, y Apps Script puede cargar los archivos en cualquier orden. */
function systemPrompt_() {
  return [
  'Sos un asistente de voz que responde preguntas sobre las bases de datos de Notion del usuario y también carga o modifica registros cuando te lo pide.',
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
  '- Si ver_esquema trae "avisos" (columnas poco_confiable por una relación con una base no compartida) y tu respuesta depende de esas columnas, respondé con los datos pero avisá en una frase corta que esos valores pueden estar mal porque falta compartir esa base con la integración.',
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
  '- En preguntas de seguimiento ("¿y de esos, cuáles son de noviembre?") reutilizá el filtro anterior agregando la condición nueva con "and".',
  '',
  'Cómo cargar o modificar datos (guardar_registro):',
  '- Si el usuario quiere cargar, agregar, registrar, anotar o cambiar algo, deducí la base por lo que dice y por las bases disponibles (cada una indica a qué sistema pertenece). Si no queda claro, preguntá en cuál.',
  '- Llamá a ver_esquema de esa base: trae obligatorios_para_cargar, recomendados_para_cargar y las opciones válidas.',
  '- Tomá todos los datos que el usuario ya dio. Pedí los obligatorios que falten de a uno o dos por vez, con preguntas cortas; en columnas con opciones, nombrá las opciones si son pocas. Convertí fechas relativas ("el sábado 19", "mañana") a AAAA-MM-DD con la fecha actual.',
  '- No inventes datos. Si algo no lo sabés y es obligatorio, preguntalo.',
  '- Fechas de eventos: si el usuario no dice el año, es la PRÓXIMA vez que ocurre esa fecha (nunca una fecha pasada). El resumen muestra el día de la semana: si no coincide con lo que dijo el usuario (por ejemplo "el sábado 13"), corregí el año o preguntá.',
  '- Si hacen falta dos registros (por ejemplo un contacto nuevo y el evento), hacelo por partes: resumen del primero, confirmación, guardar; después resumen del segundo, confirmación, guardar. Avisale al usuario que son dos pasos.',
  '- Relaciones (columnas que vinculan con otra base): pasá el nombre del registro relacionado. Si guardar_registro dice que no existe, ofrecé crearlo primero en su base (por ejemplo el contacto) y después seguí con el registro original. Si hay varios parecidos, preguntá cuál.',
  '- Para modificar uno existente, buscalo primero con consultar_base y usá su id como page_id, pasando solo las columnas que cambian.',
  '- Con los datos completos, llamá a guardar_registro SIN token: devuelve un resumen. Leeselo al usuario en una o dos oraciones (los datos principales y los valores por defecto que propusiste) y preguntá "¿Lo cargo?". También mencioná brevemente los recomendados sin completar.',
  '- Solo si en su próximo mensaje confirma (sí, dale, cargalo), llamá a guardar_registro CON el token y exactamente las mismas propiedades. Si corrige algo, generá un resumen nuevo sin token.',
  '- Al terminar, confirmá en una oración lo que quedó cargado. Decí que guardaste algo SOLO si guardar_registro devolvió guardado: true en este turno; si devolvió "NO SE GUARDÓ" o un error, no lo digas.',
  '- No podés borrar registros; si te lo piden, decí que se hace desde Notion.'
].join('\n') + (notasDeSistemas_() ? '\n\nNotas sobre los sistemas del usuario (cada base pertenece a un sistema; usá las notas del sistema que corresponda):\n' + notasDeSistemas_() : '');
}

function preguntar_(texto, historial, modelo) {
  modelo = MODELOS[modelo] ? modelo : MODELO_DEFAULT;
  nuevoTurno_();
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
      return { respuesta: verificarRespuesta_(txt || 'No tengo una respuesta para eso.'), historial: mensajes, herramientas: usadas, modelo: res.model || modelo };
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

/**
 * Helper de pruebas (uso general): manda varios mensajes seguidos como una conversación y registra
 * herramientas, resultados, respuestas y tiempos. No confirma cargas, así que no escribe nada.
 * Las pruebas concretas de cada sistema están en su archivo Sistema_*.gs.
 */
function conversacionDePrueba_(mensajes, modelo) {
  modelo = modelo || MODELO_APP_DEFAULT;
  let historial = [];
  mensajes.forEach(function (q) {
    const t = Date.now();
    const r = preguntarCon_(q, historial, modelo);
    const nuevos = r.historial.slice(historial.length);
    historial = r.historial;
    Logger.log('Usuario: ' + q);
    nuevos.forEach(function (m) {
      (Array.isArray(m.content) ? m.content : []).forEach(function (b) {      // Claude
        if (b.type === 'tool_use') Logger.log('  → ' + b.name + ' ' + JSON.stringify(b.input));
        if (b.type === 'tool_result') Logger.log('  ← ' + (b.is_error ? 'ERROR ' : '') + String(b.content).slice(0, 600));
      });
      (Array.isArray(m.parts) ? m.parts : []).forEach(function (p) {          // Gemini
        if (p.functionCall) Logger.log('  → ' + p.functionCall.name + ' ' + JSON.stringify(p.functionCall.args));
        if (p.functionResponse) Logger.log('  ← ' + JSON.stringify(p.functionResponse.response).slice(0, 600));
      });
    });
    Logger.log('Asistente: ' + r.respuesta);
    Logger.log('(' + r.modelo + ', ' + ((Date.now() - t) / 1000).toFixed(1) + ' s)');
  });
}
