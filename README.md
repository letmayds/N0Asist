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
 │ 🔊 speechSynthesis         │ ◄───────── │  ver_esquema, consultar_base…│ ──► Notion API
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
- **IA:** Gemini Flash-Lite (gratis) por defecto; Gemini Flash, Claude Haiku 5.5 y Sonnet 5.5 se eligen en ⚙️ Ajustes.

## Uso

- Tocá **🎤** y hablá; cuando terminás de hablar, la app manda la pregunta, muestra la respuesta y la lee.
- **💬 Conversar:** al terminar de responder vuelve a escuchar sola. Si no hablás dos veces seguidas, se apaga.
  Mientras está activo, la pantalla no se apaga (si el navegador lo permite).
- **⏹ Cortar:** corta la voz, deja de escuchar, descarta la respuesta en curso y apaga el modo conversación.
- Tocá **🎤 mientras habla** para interrumpirla y preguntar otra cosa.
- **🔄** empieza una conversación nueva. Las preguntas de seguimiento ("¿y de esos, cuáles pagaron?") usan el historial.
- **⚙️ Ajustes:** URL, clave, modelo, voz en español y velocidad.

## Instalar como app en Android

Abrí la app en Chrome y tocá **📲 Instalar** (arriba) o menú ⋮ → **Instalar app**. Chrome genera una
APK (WebAPK) y la instala: queda en el cajón de apps con ícono propio y abre en pantalla completa.
Se actualiza sola cuando se publica una versión nueva. (Una APK con WebView común no serviría:
el WebView de Android no tiene reconocimiento de voz.)

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
  Ejecutá **probarGemini** para ver los modelos disponibles. Modelos: `gemini-flash-lite-latest`
  y `gemini-flash-latest`. Ojo: en el plan gratis Google puede usar los datos enviados para mejorar sus
  productos, y hay límites por minuto y por día.
- **Claude (pago):** key en <https://platform.claude.com/settings/keys> → Script Properties `ANTHROPIC_API_KEY`.
  Ejecutá **probarEventos_Consulta** (en `Sistema_Eventos.gs`) y elegí Claude Haiku 5.5 o Sonnet 5.5 en ⚙️ Ajustes.

Script Properties se editan en el editor → ⚙️ **Configuración del proyecto** → **Propiedades de la secuencia de comandos**.

Opcional: `NOTION_DATA_SOURCES` = `{"tareas":"<data_source_id>","proyectos":"<data_source_id>"}` para limitar qué bases ve el agente.

**Verificación:** en el editor ejecutá **setup** (en `Config.gs`). Revisa que estén las Script Properties,
prueba Notion (integración, bases compartidas, alias de `NOTION_DATA_SOURCES`) y Claude, y deja ✅/❌ en el registro.

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
| `apps-script/Config.gs` | Constantes (versiones de API, modelos, caché), lectura de Script Properties, `setup()` |
| `apps-script/Code.gs` | `doPost`: valida `APP_KEY` y enruta (`ping`, `notion_bases`, `notion_consulta`, `preguntar`); `generarClave` |
| `apps-script/Notion.gs` | Cliente de Notion: bases (o solo las de `NOTION_DATA_SOURCES`), esquema con tipo de resultado de fórmulas, consulta con filtro/orden/paginación/`filter_properties[]`, conteo, página completa (rollups sin truncar), normalización. Pruebas: `probarNotion`, `probarFiltroFormula` |
| `apps-script/Gemini.gs` | Loop de function calling con Gemini |
| `apps-script/Tools.gs` | Herramientas del agente (`listar_bases`, `ver_esquema`, `consultar_base`, `ver_pagina`) y dispatcher, compartidos por Claude y Gemini |
| `apps-script/Escritura.gs` | `guardar_registro`: carga y modificación en dos pasos (resumen + confirmación del usuario en otro mensaje), conversión de valores y relaciones por nombre |
| `apps-script/Archivos.gs` | Adjuntos: guarda el comprobante en Google Drive (`_Pendientes`), lo lee con la IA y, al guardar, lo mueve a la carpeta del evento y lo renombra |
| `apps-script/Agent.gs` | Ciclo de tool use con Claude (Messages API, máx. 6 vueltas), system prompt; `conversacionDePrueba_` |
| `apps-script/Sistemas.gs` | Registro de sistemas: junta la configuración de los archivos `Sistema_*.gs` |
| `apps-script/Sistema_Eventos.gs` | **Sistema de alquiler de eventos:** campos obligatorios por base, notas del negocio y pruebas (`probarEventos_Consulta`, `probarEventos_Carga`) |
| `docs/index.html` | La app de voz |
| `docs/pruebas.html` | Diagnóstico de micrófono/voz, conexión, Notion y chat de texto |

## Notas

- **Comprobantes:** tocá 📎 y elegí la foto o el PDF. El agente lee quién pagó, lo busca en Contactos, mira sus eventos con saldo, te pregunta de qué es el pago y, con tu confirmación, arma la ficha con el comprobante. El archivo se guarda en Google Drive (carpeta del evento, por ejemplo `Eventos Files 2026/2026-12-19 Fiesta Egresado/2026-11-14 Cuota 100000.jpg`) y en Notion queda el link en la columna Comprobante. Carpetas y reglas: `archivos` y notas de cada `Sistema_*.gs`.

- **Varios sistemas:** cada sistema de Notion tiene su archivo `apps-script/Sistema_<Nombre>.gs` (copiá `Sistema_Eventos.gs` como plantilla). Ahí van sus campos obligatorios y sus notas; el agente lo toma solo. Compartí sus bases con la integración.

- **Cargar datos por voz:** "Cargá un pago de 100 mil de la fiesta de egresados". El agente elige la base, pregunta lo que falta (obligatorios en el archivo `Sistema_*.gs` de cada sistema), lee un resumen y guarda solo cuando le confirmás en otro mensaje. La integración de Notion necesita las capacidades **Insertar contenido** y **Actualizar contenido**.

- **Qué significa cada columna:** el agente lee la descripción de cada propiedad en Notion (clic en la columna → Editar propiedad → Descripción) y las notas del archivo `Sistema_*.gs` de cada sistema (por ejemplo, Saldo = lo que falta para el pago total; Falta para congelar = lo que falta para congelar el precio).

- El historial se maneja *append-only* (no se reescriben turnos anteriores): el system prompt y las herramientas
  son fijos y la fecha actual viaja en cada mensaje del usuario.
- Al cambiar entre Gemini y Claude se empieza una conversación nueva (el historial de uno no sirve para el otro).
- Si una base no aparece: revisá que esté compartida con la integración (las bases nuevas tardan hasta 10 minutos
  en aparecer por la caché, o tocá "Listar bases" en la página de pruebas).
- Navegadores: Chrome en Android y escritorio. Safari en iOS tiene reconocimiento de voz, pero no está probado.
