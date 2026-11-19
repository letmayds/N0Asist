/** Configuración leída de los secretos de la Edge Function (supabase secrets set ...). */

function env(nombre: string, porDefecto?: string): string {
  const v = Deno.env.get(nombre) ?? porDefecto;
  if (v === undefined || v === "") throw new Error(`Falta el secreto ${nombre}`);
  return v;
}

export type Esfuerzo = "low" | "medium" | "high" | "xhigh" | "max";

export const CONFIG = {
  supabaseUrl: () => env("SUPABASE_URL"),
  // Inyectada automáticamente en las Edge Functions. Nunca sale de acá.
  supabaseClaveSecreta: () => Deno.env.get("SUPABASE_SECRET_KEY") ?? env("SUPABASE_SERVICE_ROLE_KEY"),
  // Único usuario habilitado (el que creaste en Authentication → Users)
  emailDueno: () => env("OWNER_EMAIL").toLowerCase(),

  modeloGeneral: () => env("MODELO_GENERAL", "claude-opus-5-5"),
  modeloModulos: () => env("MODELO_MODULOS", "claude-opus-5-5"),
  esfuerzoGeneral: () => env("ESFUERZO_GENERAL", "medium") as Esfuerzo,
  esfuerzoModulos: () => env("ESFUERZO_MODULOS", "low") as Esfuerzo,

  maxVueltasGeneral: 8,
  maxVueltasModulo: 8,
  maxProfundidad: 2,          // general -> módulo -> módulo conectado (no más)
  maxMensajesConversacion: 80, // al pasarlo se empieza una conversación nueva
  // El plan gratis de Supabase corta cada pedido a los 150 s: paramos antes para responder algo.
  tiempoMaximoMs: 130_000,
  limiteFilas: 50,
  zonaHoraria: "America/Argentina/Buenos_Aires",
};
