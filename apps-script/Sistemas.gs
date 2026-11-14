/**
 * Registro de sistemas (uso general).
 *
 * Cada sistema de Notion (alquiler de eventos, y los que se agreguen) vive en su propio archivo
 * Sistema_<Nombre>.gs y se registra con:
 *     var SISTEMAS = SISTEMAS || [];
 *     SISTEMAS.push({ nombre, bases: {...}, notas: [...] });
 * Se usa "var" (y no const) para que funcione cargue Apps Script los archivos en el orden que cargue.
 * Acá solo están las funciones que juntan esa configuración para el resto del código.
 */

var SISTEMAS = SISTEMAS || [];

function normTexto_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}
function normId_(id) {
  return String(id || '').replace(/-/g, '').toLowerCase();
}

/**
 * Configuración de una base: primero la que coincide por data_source_id; si ninguna, la primera por título
 * (así sigue funcionando aunque la base se haya recreado con otro id).
 * @return {{sistema: string, config: Object}|null}
 */
function configDeBase_(titulo, id) {
  let porTitulo = null;
  for (let i = 0; i < SISTEMAS.length; i++) {
    const sis = SISTEMAS[i];
    const bases = sis.bases || {};
    const claves = Object.keys(bases);
    for (let j = 0; j < claves.length; j++) {
      const conf = bases[claves[j]];
      if (id && conf.data_source_id && normId_(conf.data_source_id) === normId_(id)) return { sistema: sis.nombre, config: conf };
      if (!porTitulo && normTexto_(claves[j]) === normTexto_(titulo)) porTitulo = { sistema: sis.nombre, config: conf };
    }
  }
  return porTitulo;
}

/** Notas de todos los sistemas, para el system prompt. */
function notasDeSistemas_() {
  return SISTEMAS.filter(function (s) { return s.notas && s.notas.length; }).map(function (s) {
    return 'Sistema "' + s.nombre + '" (bases: ' + Object.keys(s.bases || {}).join(', ') + '):\n' + s.notas.join('\n');
  }).join('\n\n');
}
