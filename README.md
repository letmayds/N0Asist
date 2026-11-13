# Asistente de voz para Notion (Google Apps Script)

Trabajo por etapas. **Etapa actual: 2 — conexión con Notion.** (Etapas 1 y 1b ✔)

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

## Trabajar con clasp (cuando estés en una PC)

```bash
npm i -g @google/clasp
clasp login
cd N0Asist/apps-script   # el .clasp.json ya apunta al script si lo tenés
cp .clasp.json.example .clasp.json   # y pegá el scriptId (Configuración del proyecto → ID de la secuencia de comandos)
clasp push
```
`.clasp.json` y `.clasprc.json` están en `.gitignore`.
