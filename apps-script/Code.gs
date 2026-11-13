/**
 * Asistente de voz para Notion — backend (API).
 *
 * El micrófono está bloqueado dentro del iframe de las web apps de Apps Script,
 * así que el frontend vive en un hosting estático (GitHub Pages) y llama acá vía doPost.
 *
 * Seguridad: cada pedido debe traer la clave APP_KEY, guardada en Script Properties.
 * Sin la clave no se ejecuta nada.
 */

/** Ejecutá esta función UNA vez desde el editor: crea la APP_KEY y la muestra en el registro. */
function generarClave() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('APP_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('APP_KEY', key);
  }
  Logger.log('Tu APP_KEY (pegala en la app la primera vez): ' + key);
}

function doGet() {
  return ContentService.createTextOutput('API del asistente de Notion funcionando. Usá la app web.');
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const key = PropertiesService.getScriptProperties().getProperty('APP_KEY');
    if (!key) return json_({ ok: false, error: 'Falta configurar APP_KEY: ejecutá generarClave() en el editor.' });
    if (req.key !== key) {
      Utilities.sleep(1500); // frena intentos de adivinar la clave
      return json_({ ok: false, error: 'Clave incorrecta.' });
    }
    switch (req.action) {
      case 'ping':
        return json_({
          ok: true,
          msg: 'pong',
          hora: new Date().toLocaleString('es-AR', { timeZone: Session.getScriptTimeZone() })
        });
      case 'notion_bases':
        return json_({ ok: true, bases: listarBases_(!!req.forzar) });
      case 'notion_consulta':
        return json_({ ok: true, datos: consultarBase_(req.base, req.filtro, req.orden, req.limite) });
      default:
        return json_({ ok: false, error: 'Acción desconocida: ' + req.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
