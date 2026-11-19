/**
 * Registro de módulos. Para sumar uno nuevo:
 *   1. Copiá _plantilla.ts como <id>.ts y completalo.
 *   2. Creá su migración en supabase/migrations (tablas <id>_<tabla>, ver 20261119000100_modulo_notas.sql).
 *   3. Importalo y agregalo a MODULOS acá abajo.
 *   4. supabase db push && supabase functions deploy agente
 */
import type { Modulo } from "../tipos.ts";
import { notas } from "./notas.ts";

export const MODULOS: Modulo[] = [
  notas,
];

export function moduloPorId(id: string): Modulo | undefined {
  return MODULOS.find((m) => m.id === id);
}
