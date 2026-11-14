/**
 * Archivos adjuntos desde la app (uso general): comprobantes de pago en foto o PDF.
 *
 * Cuando llega un archivo con la pregunta:
 *   1. Se guarda en Google Drive, en la carpeta "_Pendientes" (dentro de la carpeta raíz del sistema).
 *   2. La IA lee el comprobante y devuelve los datos en JSON (quién transfiere, monto, fecha…).
 *   3. Se le pasa al agente como texto, con el valor "drive:<id>" para la columna de comprobante.
 * Al guardar el registro en Notion, la columna queda con el link del archivo y el archivo se mueve a la
 * carpeta que corresponde (por ejemplo la del evento) y se renombra, según la regla "archivos" del
 * archivo Sistema_*.gs. Qué hacer con los datos leídos (a quién y a qué corresponde) lo dicen sus notas.
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

  // 1) Guardar en Drive (pendiente hasta que se confirme el registro)
  try {
    const f = carpetaPendientes_().createFile(Utilities.newBlob(bytes, tipo,
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH.mm.ss') + ' ' + nombre));
    partes.push('Ya está guardado en Google Drive (pendiente): para adjuntarlo, en la columna de comprobante (por ejemplo "Comprobante") usá el valor "drive:' + f.getId() + '" en guardar_registro; al guardar queda el link y el archivo se ordena solo en su carpeta.');
  } catch (e) {
    partes.push('No se pudo guardar el archivo en Drive (' + e.message + '), así que no se puede adjuntar; los datos sí se pueden cargar.');
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

// ---------------------------------------------------------------------------
// Google Drive: carpetas y archivado
// ---------------------------------------------------------------------------

/** Reglas "archivos" de todos los sistemas. */
function reglasArchivos_() {
  const out = [];
  SISTEMAS.forEach(function (s) { (s.archivos || []).forEach(function (r) { out.push(r); }); });
  return out;
}

/** "_Pendientes" dentro de la carpeta raíz de la primera regla de archivos. */
function carpetaPendientes_() {
  const r = reglasArchivos_()[0];
  if (!r || !r.carpeta_raiz) throw new Error('no hay ninguna carpeta de Drive configurada (regla "archivos" en Sistema_*.gs)');
  return subcarpeta_(DriveApp.getFolderById(r.carpeta_raiz), '_Pendientes');
}

function subcarpeta_(padre, nombre) {
  const it = padre.getFoldersByName(nombre);
  return it.hasNext() ? it.next() : padre.createFolder(nombre);
}

/**
 * Carpeta del año: si el evento es de otro año que la carpeta raíz ("Eventos Files 2026"), usa o crea
 * la carpeta hermana con ese año ("Eventos Files 2027") en la misma carpeta madre.
 */
function carpetaDelAnio_(raiz, anio) {
  const nombre = raiz.getName();
  const m = nombre.match(/(19|20)\d{2}/);
  if (!anio || !m || m[0] === anio) return raiz;
  const padres = raiz.getParents();
  if (!padres.hasNext()) return raiz;
  return subcarpeta_(padres.next(), nombre.replace(m[0], anio));
}

/** Valor de una propiedad ya convertida al formato de Notion, como texto para nombres de archivo. */
function textoDePropNotion_(n) {
  if (!n) return '';
  if (n.date) return String(n.date.start || '').slice(0, 10);
  if (n.select) return n.select.name;
  if (n.status) return n.status.name;
  if (typeof n.number === 'number') return String(n.number);
  if (n.title) return n.title.map(function (t) { return t.text.content; }).join('');
  if (n.rich_text) return n.rich_text.map(function (t) { return t.text.content; }).join('');
  return '';
}

/**
 * Después de guardar un registro: mueve y renombra los archivos "drive:<id>" según las reglas.
 * Ejemplo (eventos): Comprobante de un pago → "Eventos Files 2026/2026-12-19 Fiesta Egresado/2026-11-14 Cuota 100000.jpg".
 * @return {Array<string>} rutas finales (para informar)
 */
function archivarAdjuntos_(esq, crudo, notion) {
  const hechos = [];
  reglasArchivos_().forEach(function (r) {
    const coincide = (r.data_source_id && normId_(r.data_source_id) === normId_(esq.data_source_id)) || normTexto_(r.base) === normTexto_(esq.titulo);
    if (!coincide) return;
    const m = String(crudo[r.columna] || '').match(/^drive:([\w-]+)$/);
    if (!m) return;
    const archivo = DriveApp.getFileById(m[1]);

    // Carpeta destino: la del registro relacionado (por ejemplo el evento), con fecha y nombre.
    let destino = DriveApp.getFolderById(r.carpeta_raiz);
    if (r.relacion && notion[r.relacion] && notion[r.relacion].relation && notion[r.relacion].relation.length) {
      const pg = notion_('get', '/pages/' + notion[r.relacion].relation[0].id);
      const props = pg.properties || {};
      const tit = Object.keys(props).map(function (k) { return props[k]; }).find(function (x) { return x.type === 'title'; });
      const nombreRel = tit ? textoPlano_(tit.title) : 'Sin nombre';
      const fp = r.fecha_relacion && props[r.fecha_relacion] && props[r.fecha_relacion].date;
      const fecha = fp && fp.start ? fp.start.slice(0, 10) : '';
      destino = subcarpeta_(carpetaDelAnio_(destino, fecha.slice(0, 4)), ((fecha ? fecha + ' ' : 'Sin fecha ') + nombreRel).replace(/[\\/]/g, '-').trim());
    }

    // Nombre del archivo: columnas indicadas (por ejemplo "2026-11-14 Cuota 100000") + extensión original.
    const ext = (archivo.getName().match(/\.[a-z0-9]{2,4}$/i) || [''])[0];
    let base = (r.nombre_archivo || []).map(function (c) { return textoDePropNotion_(notion[c]); }).filter(String).join(' ').replace(/[\\/:*?"<>|]/g, '-').trim();
    if (!base) base = archivo.getName().replace(/\.[^.]+$/, '');
    let nombre = base + ext, i = 2;
    while (destino.getFilesByName(nombre).hasNext()) nombre = base + ' (' + (i++) + ')' + ext;
    archivo.setName(nombre);
    archivo.moveTo(destino);
    hechos.push(destino.getName() + '/' + nombre);
  });
  return hechos;
}
