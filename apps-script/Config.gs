/**
 * Configuración central: Script Properties, constantes y setup().
 *
 * Script Properties (editor → ⚙️ Configuración del proyecto → Propiedades de la secuencia de comandos):
 *   NOTION_TOKEN         (obligatoria) token de la integración interna de Notion (ntn_…).
 *   ANTHROPIC_API_KEY    (obligatoria) key de la API de Claude (sk-ant-…).
 *   APP_KEY              (obligatoria) clave que manda el frontend en cada pedido. La crea generarClave().
 *   NOTION_DATA_SOURCES  (opcional)    JSON {"alias": "data_source_id"} para limitar qué bases ve el agente.
 *   GEMINI_API_KEY       (obligatoria para Gemini, el proveedor por defecto de la app) aistudio.google.com/apikey.
 */

// --- Notion ---
const NOTION_VERSION = '2026-03-11';
const NOTION_API = 'https://api.notion.com/v1';
const CACHE_TTL_SEG = 600; // esquemas y listado de bases: 10 minutos

// --- Claude ---
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2026-10-21';
const MODELOS = {
  'claude-haiku-5-5': { effort: 'low' },                 // rápido, por defecto
  'claude-sonnet-5-5': { effort: 'low', fallback: true } // consultas complejas
};
const MODELO_DEFAULT = 'claude-haiku-5-5';   // modelo de Claude cuando se elige Claude
const MODELO_APP_DEFAULT = 'gemini-flash-lite-latest'; // modelo por defecto de la app (Gemini, gratis)

/**
 * Notas del negocio para el agente: qué significa cada columna y cómo responder.
 * Se agregan al system prompt. También lee la descripción de cada propiedad en Notion (ver_esquema).
 */
const NOTAS_NEGOCIO = [
  'Base Eventos (alquiler de salón):',
  '- "Saldo": lo que le falta pagar al cliente para completar el pago total del evento. Si preguntan cuánto falta pagar, cuánto deben o quién debe, es esta columna (Saldo mayor a 0).',
  '- "Falta para congelar": lo que le falta pagar para congelar el precio (que no se actualice por IPC). No es la deuda total.',
  '- Cuando hables de lo que falta pagar de un evento, decí el Saldo y, si "Falta para congelar" es mayor a 0, aclará también cuánto le falta para congelar el precio.',
  '- Las fechas límite son "Límite seña" y "Límite pago total"; mencionalas si sirven (por ejemplo, si están cerca o vencidas).'
].join('\n');

const PROPS_OBLIGATORIAS = ['NOTION_TOKEN', 'ANTHROPIC_API_KEY', 'APP_KEY'];

/** Lee una Script Property. Si es obligatoria y falta, tira un error claro en español. */
function prop_(nombre, obligatoria) {
  const v = PropertiesService.getScriptProperties().getProperty(nombre);
  if (obligatoria && !v) throw new Error('Falta ' + nombre + ' en Script Properties. Cargala y ejecutá setup().');
  return v || '';
}

/**
 * Devuelve el mapa {alias: data_source_id} de NOTION_DATA_SOURCES, o null si no está definido
 * (en ese caso el agente ve todas las bases compartidas con la integración).
 */
function notionDataSources_() {
  const raw = prop_('NOTION_DATA_SOURCES', false).trim();
  if (!raw) return null;
  let obj;
  try { obj = JSON.parse(raw); } catch (e) {
    throw new Error('NOTION_DATA_SOURCES no es un JSON válido. Formato: {"tareas":"<id>","proyectos":"<id>"}');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('NOTION_DATA_SOURCES tiene que ser un objeto {"alias": "data_source_id"}.');
  }
  return obj;
}

/**
 * Ejecutala desde el editor después de cargar las Script Properties.
 * Valida que existan, prueba Notion y Claude, y deja todo en el registro.
 */
function setup() {
  const log = function (ok, msg) { Logger.log((ok ? '✅ ' : '❌ ') + msg); };
  let todoOk = true;

  // 1. Script Properties
  PROPS_OBLIGATORIAS.forEach(function (p) {
    const ok = !!prop_(p, false);
    if (!ok) todoOk = false;
    log(ok, p + (ok ? ' cargada' : ' FALTA' + (p === 'APP_KEY' ? ' (ejecutá generarClave())' : '')));
  });
  let alias = null;
  try {
    alias = notionDataSources_();
    log(true, 'NOTION_DATA_SOURCES: ' + (alias ? Object.keys(alias).join(', ') : 'no definida (se usan todas las bases compartidas)'));
  } catch (e) { todoOk = false; log(false, e.message); }

  // 2. Notion
  if (prop_('NOTION_TOKEN', false)) {
    try {
      const yo = notion_('get', '/users/me');
      log(true, 'Notion: conectado como integración "' + (yo.name || yo.id) + '"');
      const r = notion_('post', '/search', { filter: { property: 'object', value: 'data_source' }, page_size: 100 });
      const n = (r.results || []).length;
      log(n > 0, 'Notion: ' + n + (r.has_more ? '+' : '') + ' bases compartidas con la integración' +
        (n ? '' : ' — compartí cada base: ••• → Conexiones → tu integración'));
      if (!n) todoOk = false;
      if (alias) {
        Object.keys(alias).forEach(function (a) {
          try {
            const ds = notion_('get', '/data_sources/' + alias[a]);
            log(true, '  ' + a + ' → "' + textoPlano_(ds.title) + '"');
          } catch (e) { todoOk = false; log(false, '  ' + a + ' → ' + e.message); }
        });
      }
    } catch (e) { todoOk = false; log(false, 'Notion: ' + e.message); }
  }

  // 2b. Relaciones con bases no compartidas (dan 0/vacío en rollups y fórmulas)
  if (prop_('NOTION_TOKEN', false)) {
    try {
      listarBases_(true).forEach(function (b) {
        (verEsquema_(b.id, true).avisos || []).forEach(function (a) { todoOk = false; log(false, b.nombre + ': ' + a); });
      });
    } catch (e) { log(false, 'Revisión de relaciones: ' + e.message); }
  }

  // 3. Claude
  if (prop_('ANTHROPIC_API_KEY', false)) {
    try {
      const res = UrlFetchApp.fetch(ANTHROPIC_URL, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { 'x-api-key': prop_('ANTHROPIC_API_KEY'), 'anthropic-version': ANTHROPIC_VERSION },
        payload: JSON.stringify({ model: MODELO_DEFAULT, max_tokens: 20, messages: [{ role: 'user', content: 'Respondé solo: ok' }] })
      });
      const code = res.getResponseCode();
      const data = JSON.parse(res.getContentText() || '{}');
      if (code === 200) log(true, 'Claude (' + MODELO_DEFAULT + '): respondió "' + ((data.content || [])[0] || {}).text + '"');
      else { todoOk = false; log(false, 'Claude ' + code + ': ' + ((data.error && data.error.message) || res.getContentText().slice(0, 200))); }
    } catch (e) { todoOk = false; log(false, 'Claude: ' + e.message); }
  }

  // 4. Gemini (proveedor por defecto de la app)
  if (prop_('GEMINI_API_KEY', false)) {
    const key = prop_('GEMINI_API_KEY');
    const t0 = Date.now();
    const seg = function () { return ((Date.now() - t0) / 1000).toFixed(1) + ' s'; };
    try {
      // 1) Listar modelos: no gasta cuota y responde rápido; confirma que la key sirve.
      Logger.log('… Gemini: verificando la key');
      const lm = UrlFetchApp.fetch(GEMINI_API + '?pageSize=100', { headers: { 'x-goog-api-key': key }, muteHttpExceptions: true });
      const lmd = JSON.parse(lm.getContentText() || '{}');
      if (lm.getResponseCode() !== 200) throw new Error('la key no funciona (' + lm.getResponseCode() + '): ' + ((lmd.error && lmd.error.message) || '').slice(0, 200));
      const nombres = (lmd.models || []).map(function (m) { return m.name.replace('models/', ''); });
      log(true, 'Gemini: key válida (' + seg() + '). Modelo por defecto ' + MODELO_APP_DEFAULT + (nombres.indexOf(MODELO_APP_DEFAULT) >= 0 ? ' disponible' : ' NO aparece en la lista'));

      // 2) Pregunta mínima, con pocos tokens.
      Logger.log('… Gemini: pregunta de prueba');
      const g = UrlFetchApp.fetch(GEMINI_API + MODELO_APP_DEFAULT + ':generateContent', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { 'x-goog-api-key': key },
        payload: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Respondé solo: ok' }] }],
          generationConfig: { maxOutputTokens: 20 }
        })
      });
      const gd = JSON.parse(g.getContentText() || '{}');
      if (g.getResponseCode() === 200) log(true, 'Gemini (' + MODELO_APP_DEFAULT + '): respondió "' + String(((((gd.candidates || [])[0] || {}).content || {}).parts || [{}])[0].text || '').trim() + '" en ' + seg());
      else { todoOk = false; log(false, 'Gemini ' + g.getResponseCode() + ' en ' + seg() + ': ' + ((gd.error && gd.error.message) || '').slice(0, 300)); }
    } catch (e) { todoOk = false; log(false, 'Gemini (' + seg() + '): ' + e.message); }
  } else {
    todoOk = false;
    log(false, 'GEMINI_API_KEY FALTA: la app usa Gemini por defecto (key gratis en aistudio.google.com/apikey)');
  }

  Logger.log(todoOk ? '🎉 Todo listo.' : '⚠️ Hay cosas para corregir (ver arriba).');
  return todoOk;
}
