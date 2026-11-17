/**
 * Progreso de cada pedido (uso general): el backend va anotando los pasos ("Leyendo el archivo con
 * Gemini…", "Consultando Servicios…") y la app los consulta mientras espera la respuesta, para mostrarlos
 * en la leyenda debajo del botón. Apps Script no puede mandar respuestas parciales, por eso se usa la
 * caché (compartida entre ejecuciones) y la app pregunta cada 1,5 s con la acción "progreso".
 *
 * Los cambios automáticos de modelo se anotan además como "avisos", que vuelven con la respuesta.
 */

var PROGRESO_ID_ = null;   // id del pedido actual (lo genera la app)
var AVISOS_ = [];          // avisos importantes de este pedido (cambio de modelo, reintentos)

function iniciarProgreso_(id) {
  PROGRESO_ID_ = id ? String(id).replace(/[^\w-]/g, '').slice(0, 40) || null : null;
  AVISOS_ = [];
}

/** Anota un paso para que la app lo muestre. No falla nunca (si la caché no responde, se ignora). */
function paso_(texto) {
  if (!PROGRESO_ID_) return;
  try {
    const cache = CacheService.getScriptCache();
    const clave = 'prog_' + PROGRESO_ID_;
    const lista = JSON.parse(cache.get(clave) || '[]');
    lista.push(String(texto).slice(0, 160));
    cache.put(clave, JSON.stringify(lista.slice(-30)), 600);
  } catch (e) { /* el progreso es solo informativo */ }
}

/** Un aviso importante (por ejemplo, cambio automático de modelo): se muestra y vuelve con la respuesta. */
function aviso_(texto) {
  AVISOS_.push(String(texto));
  paso_('⚠️ ' + texto);
}

function leerProgreso_(id) {
  const limpio = String(id || '').replace(/[^\w-]/g, '').slice(0, 40);
  if (!limpio) return [];
  try { return JSON.parse(CacheService.getScriptCache().get('prog_' + limpio) || '[]'); }
  catch (e) { return []; }
}

/** Nombre corto del modelo para mostrar ("Gemini Flash-Lite", "Claude Haiku"). */
function nombreModelo_(modelo) {
  const m = String(modelo || '');
  if (/flash-lite/.test(m)) return 'Gemini Flash-Lite';
  if (/gemini.*flash/.test(m)) return 'Gemini Flash';
  if (/haiku/.test(m)) return 'Claude Haiku';
  if (/sonnet/.test(m)) return 'Claude Sonnet';
  return m;
}

/** Texto del paso para cada herramienta del agente. */
function describirHerramienta_(nombre, input) {
  input = input || {};
  let base = '';
  try {
    const ref = input.data_source_id;
    if (ref) {
      const b = listarBases_().find(function (x) { return normId_(x.id) === normId_(ref) || normTexto_(x.nombre) === normTexto_(ref) || normTexto_(x.alias) === normTexto_(ref); });
      base = b ? b.nombre : String(ref);
    }
  } catch (e) { base = ''; }
  switch (nombre) {
    case 'listar_bases': return 'Revisando las bases disponibles…';
    case 'ver_esquema': return 'Leyendo las columnas de ' + (base || 'la base') + '…';
    case 'consultar_base': return (input.solo_contar ? 'Contando en ' : 'Consultando ') + (base || 'Notion') + '…';
    case 'ver_pagina': return 'Abriendo el registro…';
    case 'guardar_registro': return input.token ? 'Guardando en ' + (base || 'Notion') + '…' : 'Armando la ficha' + (base ? ' de ' + base : '') + '…';
    default: return 'Trabajando…';
  }
}
