/**
 * Proveedor alternativo (gratis): Gemini API de Google AI Studio, con function calling.
 *
 * - API key en Script Properties: GEMINI_API_KEY (https://aistudio.google.com/apikey).
 * - Modelos: se usan los alias "-latest" de Google para no depender de un número de versión.
 * - Mismo esquema que Claude: historial append-only (se devuelve el "content" del modelo tal cual,
 *   incluidas las thoughtSignature), system prompt y tools fijos, fecha en el mensaje del usuario.
 * - filtro y orden viajan como texto JSON: el esquema de Gemini no acepta bien objetos libres.
 */

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/';
const GEMINI_MODELOS = ['gemini-flash-lite-latest', 'gemini-flash-latest'];

const GEMINI_TOOLS = [{
  functionDeclarations: [
    {
      name: 'listar_bases',
      description: 'Devuelve las bases de Notion disponibles con su id, nombre y propiedades (tipo y, para select/status/multi_select, las opciones válidas).'
    },
    {
      name: 'consultar_base',
      description: 'Consulta una base de Notion y devuelve las filas simplificadas (propiedad: valor), la cantidad y truncado (true si quedaron filas sin traer).',
      parameters: {
        type: 'object',
        properties: {
          base: { type: 'string', description: 'Nombre o id de la base.' },
          filtro_json: { type: 'string', description: 'Objeto "filter" de la API de Notion escrito como texto JSON. Vacío si no hay filtro.' },
          orden_json: { type: 'string', description: 'Array "sorts" de la API de Notion escrito como texto JSON. Vacío si no importa el orden.' },
          limite: { type: 'integer', description: 'Máximo de filas a traer (1 a 200, por defecto 50).' },
          solo_contar: { type: 'boolean', description: 'true para devolver solo la cantidad de filas que cumplen el filtro (hasta 1000).' }
        },
        required: ['base']
      }
    }
  ]
}];

function preguntarGemini_(texto, historial, modelo) {
  modelo = GEMINI_MODELOS.indexOf(modelo) >= 0 ? modelo : GEMINI_MODELOS[0];
  const contents = Array.isArray(historial) ? historial.slice() : [];
  const ahora = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'EEEE yyyy-MM-dd HH:mm');

  const parts = [];
  if (!contents.length) parts.push({ text: 'Bases disponibles: ' + JSON.stringify(listarBasesParaClaude_()) });
  parts.push({ text: '[' + ahora + '] ' + String(texto || '').trim() });
  contents.push({ role: 'user', parts: parts });

  const usadas = [];
  for (let vuelta = 0; vuelta < MAX_VUELTAS_TOOLS; vuelta++) {
    const res = llamarGemini_(modelo, contents);
    const cand = (res.candidates || [])[0];
    if (!cand || !cand.content || !cand.content.parts) {
      const motivo = (res.promptFeedback && res.promptFeedback.blockReason) || (cand && cand.finishReason) || 'sin respuesta';
      return { respuesta: 'No pude responder eso (' + motivo + '). Probá reformularlo.', historial: historial || [], herramientas: usadas, modelo: modelo };
    }

    contents.push(cand.content); // tal cual: conserva thoughtSignature
    const llamadas = cand.content.parts.filter(function (p) { return p.functionCall; });
    if (!llamadas.length) {
      const txt = cand.content.parts.filter(function (p) { return p.text && !p.thought; }).map(function (p) { return p.text; }).join(' ').trim();
      return { respuesta: txt || 'No tengo una respuesta para eso.', historial: contents, herramientas: usadas, modelo: res.modelVersion || modelo };
    }

    const respuestas = llamadas.map(function (p) {
      const fc = p.functionCall, args = fc.args || {};
      usadas.push({ nombre: fc.name, input: args });
      let response;
      try {
        response = { resultado: ejecutarHerramientaGemini_(fc.name, args) };
      } catch (err) {
        response = { error: String(err && err.message || err) };
      }
      const fr = { name: fc.name, response: response };
      if (fc.id) fr.id = fc.id;
      return { functionResponse: fr };
    });
    contents.push({ role: 'user', parts: respuestas });
  }
  return { respuesta: 'Me enredé consultando Notion. ¿Me lo preguntás de otra forma?', historial: contents, herramientas: usadas, modelo: modelo };
}

function ejecutarHerramientaGemini_(nombre, a) {
  if (nombre === 'listar_bases') return listarBasesParaClaude_(true);
  if (nombre !== 'consultar_base') throw new Error('Herramienta desconocida: ' + nombre);
  const parse = function (s, campo) {
    if (s === undefined || s === null || s === '') return null;
    if (typeof s === 'object') return s;
    try { return JSON.parse(s); } catch (e) { throw new Error(campo + ' no es JSON válido: ' + e.message); }
  };
  const filtro = parse(a.filtro_json, 'filtro_json'), orden = parse(a.orden_json, 'orden_json');
  if (a.solo_contar) return contarBase_(a.base, filtro);
  return consultarBase_(a.base, filtro, orden, a.limite);
}

function llamarGemini_(modelo, contents) {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('Falta GEMINI_API_KEY en Script Properties.');
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT + '\n- En consultar_base, filtro_json y orden_json van como texto JSON con esa misma sintaxis.' }] },
    contents: contents,
    tools: GEMINI_TOOLS,
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
  };
  let ultimo = '';
  for (let intento = 0; intento < 3; intento++) {
    const r = UrlFetchApp.fetch(GEMINI_API + modelo + ':generateContent', {
      method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(body), muteHttpExceptions: true
    });
    const code = r.getResponseCode();
    const data = JSON.parse(r.getContentText() || '{}');
    if (code === 200) return data;
    const msg = (data.error && data.error.message) || r.getContentText().slice(0, 200);
    ultimo = 'Gemini ' + code + ': ' + msg;
    if (code === 429) {
      // Cuota del plan gratis: si es por minuto, Google indica cuánto esperar.
      const info = ((data.error && data.error.details) || []).filter(function (d) { return d.retryDelay; })[0];
      const seg = info ? parseFloat(info.retryDelay) : 0;
      if (seg && seg <= 20 && intento < 2) { Utilities.sleep(seg * 1000); continue; }
      throw new Error('Se agotó la cuota gratis de Gemini por ahora. Esperá un rato o probá el otro modelo. (' + msg.slice(0, 120) + ')');
    }
    if (code >= 500) { Utilities.sleep(Math.pow(2, intento) * 1000); continue; }
    throw new Error(ultimo);
  }
  throw new Error(ultimo);
}

/** Desde el editor: lista los modelos que tu key puede usar y hace una pregunta de prueba. */
function probarGemini() {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  const r = UrlFetchApp.fetch(GEMINI_API + '?pageSize=100', { headers: { 'x-goog-api-key': key }, muteHttpExceptions: true });
  const modelos = (JSON.parse(r.getContentText()).models || [])
    .filter(function (m) { return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0; })
    .map(function (m) { return m.name.replace('models/', ''); });
  Logger.log('Modelos disponibles: ' + modelos.join(', '));
  const res = preguntarGemini_('¿Qué bases tengo y para qué sirve cada una?', [], GEMINI_MODELOS[0]);
  Logger.log('Respuesta: ' + res.respuesta);
  Logger.log('Herramientas: ' + JSON.stringify(res.herramientas));
}
