/**
 * Ciclo de tool use con Claude, compartido por el agente general y los módulos.
 * Historial append-only: se agrega la respuesta completa (incluye bloques de thinking) y nunca se reescribe.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Esfuerzo } from "./config.ts";

const cliente = new Anthropic(); // lee ANTHROPIC_API_KEY de los secretos

export type Mensaje = Anthropic.Beta.BetaMessageParam;

export interface OpcionesCiclo {
  modelo: string;
  esfuerzo: Esfuerzo;
  system: string;
  herramientas: Anthropic.Beta.BetaTool[];
  mensajes: Mensaje[];          // se modifica: quedan agregadas las vueltas nuevas
  maxVueltas: number;
  limite: number;               // Date.now() máximo para pedir otra vuelta
  ejecutar: (nombre: string, entrada: Record<string, unknown>) => Promise<string>;
}

function textoDe(contenido: Anthropic.Beta.BetaContentBlock[]): string {
  return contenido.filter((b) => b.type === "text").map((b) => (b as Anthropic.Beta.BetaTextBlock).text).join("\n").trim();
}

export async function cicloClaude(o: OpcionesCiclo): Promise<string> {
  for (let vuelta = 0; vuelta < o.maxVueltas; vuelta++) {
    // Margen para que la llamada a la API termine antes del corte de la Edge Function
    if (Date.now() > o.limite - 25_000) {
      return "Se me acabó el tiempo de este pedido antes de terminar. Pedímelo de nuevo, o en partes más chicas.";
    }

    const respuesta = await cliente.beta.messages.create({
      model: o.modelo,
      max_tokens: 16000,
      system: o.system,
      tools: o.herramientas,
      messages: o.mensajes,
      output_config: { effort: o.esfuerzo },
      cache_control: { type: "ephemeral" },
      // Si un filtro de seguridad rechaza el pedido, la API lo reintenta sola con el modelo adecuado
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    o.mensajes.push({ role: "assistant", content: respuesta.content });

    switch (respuesta.stop_reason) {
      case "refusal":
        return "No puedo ayudar con ese pedido.";
      case "pause_turn":
        continue;
      case "max_tokens":
        return (textoDe(respuesta.content) + "\n\n(La respuesta quedó cortada por largo.)").trim();
      case "tool_use":
        break;
      default:
        return textoDe(respuesta.content) || "Listo.";
    }

    const llamadas = respuesta.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    // Todas las herramientas de esta vuelta en paralelo; todos los resultados en un solo mensaje
    const resultados = await Promise.all(llamadas.map(async (ll): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
      try {
        const salida = await o.ejecutar(ll.name, (ll.input ?? {}) as Record<string, unknown>);
        return { type: "tool_result", tool_use_id: ll.id, content: salida };
      } catch (e) {
        return { type: "tool_result", tool_use_id: ll.id, content: `Error: ${(e as Error).message}`, is_error: true };
      }
    }));
    o.mensajes.push({ role: "user", content: resultados });
  }
  return "Hice varios pasos y no llegué a una respuesta final. Probá con un pedido más concreto.";
}
