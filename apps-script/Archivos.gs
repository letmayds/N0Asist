/**
 * Archivos adjuntos desde la app (uso general): comprobantes de pago en foto o PDF.
 *
 * Cuando llega un archivo con la pregunta:
 *   1. Se sube a Notion (File Upload API) para poder adjuntarlo en una columna de tipo archivo
 *      (por ejemplo "Comprobante" en Pagos). Notion lo guarda hasta 1 hora sin adjuntar.
 *   2. La IA lee el comprobante y devuelve los datos en JSON (quién transfiere, monto, fecha…).
 *   3. Se le pasa al agente como texto, así el historial no carga la imagen en cada turno.
 * Qué hacer con esos datos (a qué contacto y a qué pago corresponden) lo dicen las notas de cada
 * archivo Sistema_*.gs.
 */

const TIPOS_ARCHIVO = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
const MAX_BYTES_ARCHIVO = 8 * 1024 * 1024;

/**
 * @param {{nombre: string, tipo: string, datos: string}} archivo  datos en base64 (sin "data:...;base64,")
 * @param {string} modelo  modelo elegido en la app (define qué IA lee el comprobante)
 * @return {string} texto para anteponer al mensaje del usuario
 */
function procesarAdjunto_(archivo, modelo) {
  if (!archivo || !archivo.datos) return '';
  const tipo = String(archivo.tipo || '').toLowerCase();
  const nombre = String(archivo.nombre || 'comprobante').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
  if (TIPOS_ARCHIVO.indexOf(tipo) < 0) throw new Error('Tipo de archivo no soportado (' + tipo + '). Mandá una foto (JPG o PNG) o un PDF.');
  const bytes = Utilities.base64Decode(archivo.datos);
  if (bytes.length > MAX_BYTES_ARCHIVO) throw new Error('El archivo es muy grande (máximo 8 MB).');

  const partes = ['[Archivo adjunto por el usuario: "' + nombre + '".'];

  // 1) Subir a Notion
  try {
    const id = subirArchivoNotion_(Utilities.newBlob(bytes, tipo, nombre));
    partes.push('Ya está subido a Notion: para adjuntarlo en una columna de tipo archivo (por ejemplo "Comprobante") usá el valor "file_upload:' + id + '|' + nombre + '" en guardar_registro (vale por 1 hora).');
  } catch (e) {
    partes.push('No se pudo subir el archivo a Notion (' + e.message + '), así que no se puede adjuntar; los datos sí se pueden cargar.');
  }

  // 2) Leer el comprobante
  try {
    const datos = leerComprobante_(archivo.datos, tipo, modelo);
    partes.push('Datos leídos del archivo: ' + JSON.stringify(datos) + '.');
  } catch (e) {
    partes.push('No pude leer el contenido del archivo (' + e.message + '); pedile los datos al usuario.');
  }
  partes.push('Si es un comprobante de pago, seguí las notas del sistema que corresponda para identificar quién pagó y de qué es el pago, y preguntale al usuario antes de cargar nada.]');
  return partes.join(' ');
}

/** POST /v1/file_uploads + /send (multipart). Devuelve el id del file upload. */
function subirArchivoNotion_(blob) {
  const crear = notion_('post', '/file_uploads', { filename: blob.getName(), content_type: blob.getContentType() });
  const res = UrlFetchApp.fetch(NOTION_API + '/file_uploads/' + crear.id + '/send', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + prop_('NOTION_TOKEN', true), 'Notion-Version': NOTION_VERSION },
    payload: { file: blob },  // UrlFetchApp arma el multipart/form-data
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code >= 400) {
    let data = {};
    try { data = JSON.parse(res.getContentText()); } catch (e) { /* sin JSON */ }
    throw errorNotion_(code, data);
  }
  return crear.id;
}

const PROMPT_COMPROBANTE = [
  'Leé este archivo. Si es un comprobante de pago (transferencia, Mercado Pago, depósito, recibo), extraé los datos.',
  'Respondé SOLO con un objeto JSON, sin texto alrededor, con estas claves (null si no aparece):',
  '{"es_comprobante": true|false, "medio": "transferencia"|"mercado pago"|"depósito"|"efectivo"|"otro",',
  ' "monto": número sin separadores de miles, "moneda": "ARS"|"USD"|..., "fecha": "AAAA-MM-DD", "hora": "HH:MM",',
  ' "ordenante_nombre": nombre de quien paga/transfiere, "ordenante_cuit_dni": solo dígitos, "ordenante_banco": texto,',
  ' "destinatario_nombre": texto, "destinatario_cuit_dni": solo dígitos, "numero_operacion": texto,',
  ' "concepto": texto del concepto o referencia, "observaciones": cualquier otro dato útil}',
  'En Argentina los montos usan punto para miles y coma para decimales: "$ 150.000,00" es 150000.'
].join('\n');

/** Usa Claude o Gemini (según el modelo elegido en la app) para leer el comprobante. */
function leerComprobante_(base64, tipo, modelo) {
  const texto = /^claude-/.test(modelo || '') ? leerConClaude_(base64, tipo) : leerConGemini_(base64, tipo);
  const m = String(texto || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('la IA no devolvió datos');
  return JSON.parse(m[0]);
}

function leerConClaude_(base64, tipo) {
  const bloque = tipo === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: tipo, data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: tipo, data: base64 } };
  const res = UrlFetchApp.fetch(ANTHROPIC_URL, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': prop_('ANTHROPIC_API_KEY', true), 'anthropic-version': ANTHROPIC_VERSION },
    payload: JSON.stringify({ model: MODELO_DEFAULT, max_tokens: 1024, messages: [{ role: 'user', content: [bloque, { type: 'text', text: PROMPT_COMPROBANTE }] }] })
  });
  const data = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200) throw new Error('Claude ' + res.getResponseCode() + ': ' + ((data.error && data.error.message) || ''));
  return (data.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
}

function leerConGemini_(base64, tipo) {
  const res = UrlFetchApp.fetch(GEMINI_API + MODELO_APP_DEFAULT + ':generateContent', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-goog-api-key': prop_('GEMINI_API_KEY', true) },
    payload: JSON.stringify({
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: tipo, data: base64 } }, { text: PROMPT_COMPROBANTE }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 1024 }
    })
  });
  const data = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200) throw new Error('Gemini ' + res.getResponseCode() + ': ' + ((data.error && data.error.message) || ''));
  const parts = ((((data.candidates || [])[0] || {}).content || {}).parts || []);
  return parts.filter(function (p) { return p.text && !p.thought; }).map(function (p) { return p.text; }).join('');
}
