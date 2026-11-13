# Asistente de voz para Notion (Google Apps Script)

Trabajo por etapas. **Etapa actual: 3 — IA con herramientas (Gemini gratis por ahora, Claude listo para después).** (Etapas 1, 1b y 2 ✔)

## Arquitectura (plan B)

La etapa 1 confirmó que Apps Script bloquea el micrófono en su iframe
(`Permissions-Policy micrófono: BLOQUEADO`, error `not-allowed`). Por eso:

- **Frontend** (`docs/index.html`): página estática en GitHub Pages. Ahí el micrófono funciona.
- **Backend** (`apps-script/Code.gs`): web app de Apps Script que responde a `doPost`.
  Se implementa con acceso **"Cualquier usuario"** (si no, el navegador no puede llamarla desde
  otro dominio), y cada pedido debe traer la clave secreta **APP_KEY** guardada en Script Properties.
  Sin la clave no hace nada ni gasta crédito.

```
N0Asist/
  apps-script/   ← clasp push sube esta carpeta (Code.gs, appsscript.json)
  docs/          ← lo que se publica en GitHub Pages (index.html)
```

## Etapa 1b — pasos

1. **Backend:** en `apps-script/` corré `clasp push` (si pregunta por el manifiesto, contestá que sí).
2. En el editor (`clasp open`): elegí la función **generarClave** arriba → **Ejecutar** → autorizá →
   copiá la clave que aparece en el **Registro de ejecución**.
3. **Implementar → Nueva implementación → Aplicación web**: Ejecutar como **Yo**, acceso
   **Cualquier usuario**. Copiá la URL `/exec`.
   (Si ya tenías una implementación: Gestionar implementaciones → ✏️ → Nueva versión y cambiá el acceso.)
4. **Frontend:** publicá `docs/index.html` en GitHub Pages (ver abajo) y abrila en Chrome (PC y celular).
5. Pegá la URL y la clave, tocá **Probar conexión**, y probá el 🎤 y el 🔊.

### Publicar en GitHub Pages (una sola vez)
Repo → **Settings → Pages** → Source: *Deploy from a branch* → `main` / carpeta **`/docs`** → Save.
Al minuto queda en **https://letmayds.github.io/N0Asist/**

## Etapa 2 — Notion

Notion API `Notion-Version: 2026-03-11`. Las bases se consultan como *data sources*
(`POST /v1/search` con `filter.value = "data_source"`, `POST /v1/data_sources/{id}/query`).

1. Creá una integración interna en <https://www.notion.so/profile/integrations> → **Nueva integración**
   → tipo **Interna**, tu espacio de trabajo. En "Capacidades" alcanza con **Leer contenido**.
   Copiá el **token** (empieza con `ntn_`).
2. En el editor de Apps Script → ⚙️ **Configuración del proyecto** → **Propiedades de la secuencia de comandos**
   → **Agregar** → nombre `NOTION_TOKEN`, valor: el token.
3. Compartí cada base con la integración: abrí la base en Notion → **•••** (arriba a la derecha)
   → **Conexiones** → buscá tu integración → **Confirmar**.
4. En el editor elegí la función **probarNotion** → **Ejecutar** → aceptá el permiso nuevo
   ("conectarse a un servicio externo"). El registro muestra las bases que encontró.
5. En la página, tocá **📚 Listar bases** y **🔎 Ver las primeras 5 filas**.

## Etapa 3 — Gemini (gratis, proveedor por defecto mientras tanto)

`Gemini.gs` implementa el mismo loop de herramientas con la Gemini API de Google AI Studio
(function calling). Modelos: `gemini-flash-lite-latest` (por defecto, más cuota diaria) y
`gemini-flash-latest`. En la página se elige el modelo; los que empiezan con `claude-` usan Anthropic.

1. Creá una key gratis en <https://aistudio.google.com/apikey> (no pide tarjeta).
2. Script Properties → `GEMINI_API_KEY` = la key.
3. En el editor ejecutá **probarGemini**: lista los modelos que tu key puede usar y hace una pregunta de prueba.

Ojo: en el plan gratis Google puede usar lo que se envía (incluidos los datos de Notion que
lea la app) para mejorar sus productos. El plan gratis tiene límites por minuto y por día.

## Etapa 3 — Claude con herramientas

- Messages API (`anthropic-version: 2026-10-21`) llamada por HTTP desde `Claude.gs`.
- Modelo por defecto `claude-haiku-5-5`; se puede elegir `claude-sonnet-5-5` en la página
  (Sonnet usa el fallback del servidor ante rechazos de seguridad).
- Herramientas: `listar_bases` y `consultar_base(base, filtro, orden, limite, solo_contar)`.
  El backend ejecuta el loop completo de tool use (incluidas llamadas en paralelo) hasta la respuesta final.
- El historial es *append-only*: la página lo guarda y lo devuelve sin tocar. El system prompt
  y las tools son fijos; la fecha actual va en cada mensaje del usuario.

Pasos:
1. Creá una API key en <https://platform.claude.com/settings/keys>.
2. Script Properties → **Agregar** → `ANTHROPIC_API_KEY` = la key.
3. (Opcional) En el editor ejecutá **probarClaude** y mirá el registro.
4. En la página, escribí o dictá una pregunta en "Etapa 3" y tocá **Preguntar**.

## Trabajar con clasp (cuando estés en una PC)

```bash
npm i -g @google/clasp
clasp login
cd N0Asist/apps-script   # el .clasp.json ya apunta al script si lo tenés
cp .clasp.json.example .clasp.json   # y pegá el scriptId (Configuración del proyecto → ID de la secuencia de comandos)
clasp push
```
`.clasp.json` y `.clasprc.json` están en `.gitignore`.
