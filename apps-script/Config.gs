/**
 * Configuración central: Script Properties, constantes y setup().
 *
 * Script Properties (editor → ⚙️ Configuración del proyecto → Propiedades de la secuencia de comandos):
 *   NOTION_TOKEN         (obligatoria) token de la integración interna de Notion (ntn_…).
 *   ANTHROPIC_API_KEY    (obligatoria) key de la API de Claude (sk-ant-…).
 *   APP_KEY              (obligatoria) clave que manda el frontend en cada pedido. La crea generarClave().
 *   NOTION_DATA_SOURCES  (opcional)    JSON {"alias": "data_source_id"} para limitar qué bases ve el agente.
 *   GEMINI_API_KEY       (opcional)    solo si querés usar Gemini como proveedor alternativo.
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
const MODELO_DEFAULT = 'claude-haiku-5-5';

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

  Logger.log(todoOk ? '🎉 Todo listo.' : '⚠️ Hay cosas para corregir (ver arriba).');
  return todoOk;
}
