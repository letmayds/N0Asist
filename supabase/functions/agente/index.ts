/**
 * Edge Function "agente": única puerta de entrada al sistema.
 *
 * POST /functions/v1/agente   (Authorization: Bearer <token de sesión del dueño>)
 *   { accion: "chat", texto, conversacion_id? }  → respuesta del agente general + operaciones propuestas
 *   { accion: "pendientes" }                       → operaciones esperando confirmación
 *   { accion: "confirmar", id }                    → aplica la operación (sin IA)
 *   { accion: "cancelar", id }
 *   { accion: "modulos" }                          → módulos registrados y sus tablas
 */
import { CONFIG } from "./config.ts";
import { db } from "./db.ts";
import { MODULOS } from "./modulos/registro.ts";
import { cancelarOperacion, confirmarOperacion, listarPendientes } from "./operaciones.ts";
import { conversar } from "./orquestador.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(cuerpo: unknown, estado = 200): Response {
  return new Response(JSON.stringify(cuerpo), { status: estado, headers: { ...CORS, "Content-Type": "application/json" } });
}

/** Solo el dueño: token de sesión válido de Supabase Auth y email igual a OWNER_EMAIL. */
async function esDueno(req: Request): Promise<boolean> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const { data, error } = await db.auth.getUser(token);
  return !error && (data.user?.email ?? "").toLowerCase() === CONFIG.emailDueno();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Usá POST" }, 405);

  try {
    if (!(await esDueno(req))) return json({ error: "No autorizado" }, 401);
    const cuerpo = await req.json().catch(() => ({}));

    switch (cuerpo.accion) {
      case "chat": {
        const texto = String(cuerpo.texto ?? "").trim();
        if (!texto) return json({ error: "Falta el texto" }, 400);
        return json(await conversar(texto, cuerpo.conversacion_id ?? null));
      }
      case "pendientes":
        return json({ operaciones: await listarPendientes() });
      case "confirmar":
        return json(await confirmarOperacion(Number(cuerpo.id)));
      case "cancelar":
        return json(await cancelarOperacion(Number(cuerpo.id)));
      case "modulos":
        return json({
          modulos: MODULOS.map((m) => ({
            id: m.id, nombre: m.nombre, descripcion: m.descripcion,
            tablas: m.tablas.map((t) => t.nombre), conectores: m.conectores ?? [],
            reacciones: Object.keys(m.reacciones ?? {}),
          })),
        });
      default:
        return json({ error: `Acción desconocida: ${cuerpo.accion}` }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
