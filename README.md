# N0Asist — Asistente de voz para Notion

Hablás, la app te escucha, consulta tus bases de Notion con IA y te responde en voz alta, como una conversación.

- **App:** <https://letmayds.github.io/N0Asist/>
- **Diagnóstico y pruebas por etapa:** <https://letmayds.github.io/N0Asist/pruebas.html>

## Cómo funciona

```
 Celular / PC (Chrome)                      Google Apps Script (Code.gs)             APIs
 ┌───────────────────────────┐   fetch    ┌──────────────────────────────┐
 │ docs/index.html           │  doPost    │ valida APP_KEY               │
 │ 🎤 SpeechRecognition es-AR │ ─────────► │ loop de herramientas:        │ ──► Gemini / Claude
 │ 🔊 speechSynthesis         │ ◄───────── │  listar_bases, consultar_base│ ──► Notion API
 │ historial de la charla    │  respuesta │ claves en Script Properties  │
 └───────────────────────────┘            └──────────────────────────────┘
```

- **Por qué el frontend está en GitHub Pages:** las web apps de Apps Script se sirven dentro de un
  iframe que **bloquea el micrófono** (verificado en la etapa 1: `Permissions-Policy micrófono: BLOQUEADO`,
  error `not-allowed`). Por eso la página vive en GitHub Pages y Apps Script funciona como API vía `doPost`.
- **Seguridad:** para que el navegador pueda llamar a Apps Script desde otro dominio, la web app se
  implementa con acceso "Cualquier usuario", pero **cada pedido debe traer la clave `APP_KEY`**; sin ella no
  se ejecuta nada ni se gasta crédito. Las claves de Notion, Gemini y Anthropic están solo en Script
  Properties, nunca en el repo ni en la página. La URL y la `APP_KEY` quedan guardadas solo en tu navegador.
- **IA:** por ahora Gemini (gratis). Claude (Haiku 5.5 por defecto, Sonnet 5.5 opcional) ya está implementado:
  se elige en ⚙️ Ajustes cuando cargues la key de Anthropic.

## Uso

- Tocá **🎤** y hablá; cuando terminás de hablar, la app manda la pregunta, muestra la respuesta y la lee.
- **💬 Conversar:** al terminar de responder vuelve a escuchar sola. Si no hablás dos veces seguidas, se apaga.
  Mientras está activo, la pantalla no se apaga (si el navegador lo permite).
- **⏹ Cortar:** corta la voz, deja de escuchar, descarta la respuesta en curso y apaga el modo conversación.
- Tocá **🎤 mientras habla** para interrumpirla y preguntar otra cosa.
- **🔄** empieza una conversación nueva. Las preguntas de seguimiento ("¿y de esos, cuáles pagaron?") usan el historial.
- **⚙️ Ajustes:** URL, clave, modelo, voz en español y velocidad.

## Configuración desde cero

### 1. Proyecto de Apps Script
```bash
npm install -g @google/clasp
clasp login                    # activá antes la API en https://script.google.com/home/usersettings
cd apps-script
cp .clasp.json.example .clasp.json   # pegá el scriptId (o: clasp create --type webapp --rootDir .)
clasp push
```

### 2. Clave de la app (APP_KEY)
En el editor de Apps Script elegí la función **generarClave** → **Ejecutar** → copiá la clave del registro.

### 3. Notion
1. <https://www.notion.so/profile/integrations> → **Nueva integración** → tipo **Interna**,
   capacidad **Leer contenido**. Copiá el token (`ntn_…`).
2. Script Properties: `NOTION_TOKEN` = el token.
3. **Compartí cada base con la integración:** abrí la base → **•••** → **Conexiones** → tu integración → **Confirmar**.
   La app encuentra sola las bases compartidas y sus columnas (no hay que configurarlas).
4. En el editor ejecutá **probarNotion** y aceptá el permiso "conectarse a un servicio externo".

API de Notion: `Notion-Version: 2026-03-11`, bases consultadas como *data sources*
(`POST /v1/search` con `filter.value = "data_source"`, `POST /v1/data_sources/{id}/query`).

### 4. IA
- **Gemini (gratis):** key en <https://aistudio.google.com/apikey> → Script Properties `GEMINI_API_KEY`.
  Ejecutá **probarGemini** para ver los modelos disponibles. Modelos: `gemini-flash-lite-latest` (por defecto)
  y `gemini-flash-latest`. Ojo: en el plan gratis Google puede usar los datos enviados para mejorar sus
  productos, y hay límites por minuto y por día.
- **Claude (pago):** key en <https://platform.claude.com/settings/keys> → Script Properties `ANTHROPIC_API_KEY`.
  Ejecutá **probarClaude** y elegí Claude Haiku 5.5 o Sonnet 5.5 en ⚙️ Ajustes.

Script Properties se editan en el editor → ⚙️ **Configuración del proyecto** → **Propiedades de la secuencia de comandos**.

### 5. Implementar la web app
Editor → **Implementar → Nueva implementación → Aplicación web**: ejecutar como **Yo**, acceso
**Cualquier usuario** → copiá la URL `/exec`. Para actualizar sin cambiar la URL:
`clasp push` y `clasp deploy -i <ID_DE_IMPLEMENTACION>` (o Gestionar implementaciones → ✏️ → Nueva versión).

### 6. Frontend en GitHub Pages
Repo → **Settings → Pages** → *Deploy from a branch* → `main` / `/docs` → Save.
Abrí la app, completá URL y clave en ⚙️, y listo.

## Archivos

| Archivo | Qué hace |
|---|---|
| `apps-script/Code.gs` | `doPost`: valida `APP_KEY` y enruta (`ping`, `notion_bases`, `notion_consulta`, `preguntar`); `generarClave` |
| `apps-script/Notion.gs` | Cliente de Notion: listar bases con esquema, consultar con filtro/orden/paginación, contar, simplificar propiedades |
| `apps-script/Gemini.gs` | Loop de function calling con Gemini |
| `apps-script/Claude.gs` | Loop de tool use con Claude (Messages API `2026-10-21`); system prompt compartido |
| `docs/index.html` | La app de voz |
| `docs/pruebas.html` | Diagnóstico de micrófono/voz, conexión, Notion y chat de texto |

## Notas

- El historial se maneja *append-only* (no se reescriben turnos anteriores): el system prompt y las herramientas
  son fijos y la fecha actual viaja en cada mensaje del usuario.
- Al cambiar entre Gemini y Claude se empieza una conversación nueva (el historial de uno no sirve para el otro).
- Si una base no aparece: revisá que esté compartida con la integración (las bases nuevas tardan hasta 10 minutos
  en aparecer por la caché, o tocá "Listar bases" en la página de pruebas).
- Navegadores: Chrome en Android y escritorio. Safari en iOS tiene reconocimiento de voz, pero no está probado.
