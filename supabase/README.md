# N0Asist · Agente general con módulos (Supabase + Claude)

Un **agente general** (orquestador) que conversa con vos y reparte el trabajo entre **módulos**: cada módulo es
un mini agente dueño de un sector de datos (sus tablas en Supabase). Los módulos se agregan de a uno, y se
comunican entre sí con **conectores**.

- **App:** <https://letmayds.github.io/N0Asist/agente/>
- **Todo gratis** salvo la API de Claude: Supabase plan Free (Postgres + Auth + Edge Functions) y GitHub Pages.

## Cómo funciona

```
 docs/agente/ (GitHub Pages)          Edge Function "agente" (Supabase)                  Postgres (Supabase)
 ┌──────────────────────┐  token    ┌────────────────────────────────────────────┐
 │ login (Supabase Auth)│ ───────►  │ valida que seas el dueño (OWNER_EMAIL)      │
 │ chat / 🎤 / 🔊        │           │                                             │
 │ [Confirmar][Cancelar]│ ◄───────  │ Agente general ──delegar──► Agente "notas" ─┼──► notas_notas
 └──────────────────────┘           │      (Claude)    ──delegar──► Agente "pagos" ┼──► pagos_*
                                    │                         consultar_modulo ▲  │
                                    │                         (conector)       │  │
                                    │ Confirmar ──► aplica ──► evento ──► reacciones de otros módulos
                                    └────────────────────────────────────────────┘
```

- **Agente general** (`orquestador.ts`): no toca datos. Elige a qué módulo delegar (puede delegar a varios en
  paralelo) y une las respuestas.
- **Módulo** (`modulos/<id>.ts`): sus tablas, reglas del negocio, herramientas propias y conectores. Su agente
  tiene un CRUD genérico y seguro (`crud.ts`): `buscar`, `contar`, `proponer_alta`, `proponer_cambio`,
  `proponer_baja`. Solo puede tocar las tablas y columnas que declara.
- **Escrituras con confirmación:** los módulos solo *proponen*. Cada propuesta queda en la tabla `operaciones` y
  aparece como tarjeta con **Confirmar / Cancelar**. Al confirmar se aplica exactamente lo propuesto, sin IA.
  En el próximo mensaje el agente general se entera de qué se confirmó o canceló.
- **Conectores entre módulos:**
  - *Síncronos* (`conectores: ["otro"]`): el agente del módulo tiene la herramienta `consultar_modulo` para
    pedirle datos o propuestas a otro módulo. Hay protección contra ciclos y profundidad máxima 2.
  - *Asíncronos* (`reacciones`): cada operación aplicada publica un evento `<modulo>.<tabla>.<alta|cambio|baja>`
    en la tabla `eventos`; los módulos suscriptos reaccionan con código (sin IA).
- **Trazas:** cada delegación queda en `delegaciones` (pedido, respuesta, error, milisegundos); la conversación
  completa en `mensajes` (append-only).
- **Seguridad:** todas las tablas tienen RLS activado sin políticas y sin permisos para `anon`/`authenticated`:
  desde el navegador no se puede leer nada. Solo la Edge Function entra, con la clave secreta, y solo atiende
  pedidos con una sesión válida del email `OWNER_EMAIL`. La API key de Claude vive en los secretos de Supabase.
- **IA:** Claude Opus 5.5 en el agente general (esfuerzo `medium`) y en los módulos (esfuerzo `low`), con
  caché de prompts y *fallback* automático del servidor si un filtro de seguridad rechaza un pedido. Se cambia
  con los secretos `MODELO_GENERAL`, `MODELO_MODULOS`, `ESFUERZO_GENERAL`, `ESFUERZO_MODULOS`
  (por ejemplo `claude-sonnet-5-5` o `claude-haiku-5-5` para gastar menos).
- **Límite del plan gratis:** cada pedido a la Edge Function puede durar como máximo 150 s; el agente corta a los
  ~130 s y avisa. Si pasa seguido, bajá el esfuerzo o pedí cosas más chicas.

## Instalación

### 1. Proyecto en Supabase
1. Creá una cuenta y un proyecto en <https://supabase.com> (plan Free).
2. **Authentication → Users → Add user → Create new user**: tu email y una contraseña, con *Auto Confirm User*.
3. **Authentication → Sign In / Providers**: desactivá **Allow new users to sign up** (nadie más puede crearse cuenta).
4. **Project Settings → API Keys**: copiá la **URL** del proyecto y la **publishable key** (o la `anon` legacy).

### 2. Base de datos y función (Supabase CLI)
```bash
npm install -g supabase              # o: npx supabase ...
supabase login
supabase link --project-ref <ref>    # el ref está en la URL: https://<ref>.supabase.co
supabase db push                     # crea las tablas de supabase/migrations

supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   # https://platform.claude.com/settings/keys
supabase secrets set OWNER_EMAIL=tu@email.com
supabase functions deploy agente
```
Sin CLI también se puede: pegá cada archivo de `supabase/migrations` en **SQL Editor**, cargá los secretos en
**Edge Functions → Secrets** y creá la función desde el dashboard con los archivos de `supabase/functions/agente`
(con *Verify JWT* desactivado: la función valida la sesión por su cuenta).

### 3. App
Abrí <https://letmayds.github.io/N0Asist/agente/> → ⚙️ → URL y clave publicable → **Guardar** → iniciá sesión.
Probá: *"Recordame llamar al plomero el viernes"* → confirmá la tarjeta → *"¿Qué tengo pendiente?"*.

## Agregar un módulo

1. Copiá `functions/agente/modulos/_plantilla.ts` como `modulos/<id>.ts` y completá: `id`, `descripcion`
   (con esto el agente general decide cuándo usarlo), `instrucciones`, `tablas` y, si hace falta,
   `conectores`, `herramientas` y `reacciones`.
2. Creá la migración con sus tablas (`supabase migration new modulo_<id>`), siguiendo la convención de
   `20261119000100_modulo_notas.sql`: nombre `<id>_<tabla>`, `id uuid`, `creado_en`, `actualizado_en` con el
   trigger `tocar_actualizado`, RLS activado y `revoke all ... from anon, authenticated`.
3. Registralo en `modulos/registro.ts`.
4. `supabase db push && supabase functions deploy agente`.

Las columnas que declarás en el módulo son las únicas que el agente puede leer o escribir; el tipo real lo
define la migración.

## Archivos

| Archivo | Qué hace |
|---|---|
| `migrations/20261119000000_nucleo.sql` | Tablas del núcleo: `conversaciones`, `mensajes`, `operaciones`, `eventos`, `delegaciones` |
| `migrations/20261119000100_modulo_notas.sql` | Tabla del módulo de ejemplo `notas` |
| `functions/agente/index.ts` | Entrada HTTP: valida al dueño y enruta (`chat`, `pendientes`, `confirmar`, `cancelar`, `modulos`) |
| `functions/agente/orquestador.ts` | Agente general: historial, avisos de operaciones, herramienta `delegar` |
| `functions/agente/agente-modulo.ts` | Agente de cada módulo: system prompt a partir del módulo, CRUD, conectores, trazas |
| `functions/agente/claude.ts` | Ciclo de tool use con Claude (herramientas en paralelo, corte por tiempo, fallback) |
| `functions/agente/crud.ts` | CRUD genérico con validación de tablas/columnas; escrituras como propuestas |
| `functions/agente/operaciones.ts` | Confirmar/cancelar propuestas y bus de eventos con reacciones |
| `functions/agente/modulos/` | `registro.ts`, el módulo `notas.ts` y `_plantilla.ts` |
| `functions/agente/config.ts` | Secretos y límites (modelos, esfuerzo, tiempos, filas) |
| `../docs/agente/index.html` | App web: login, chat con voz, tarjetas de confirmación |
