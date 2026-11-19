import { createClient } from "@supabase/supabase-js";
import { CONFIG } from "./config.ts";

/** Cliente con la clave secreta: saltea RLS. Solo se usa dentro de la función. */
export const db = createClient(CONFIG.supabaseUrl(), CONFIG.supabaseClaveSecreta(), {
  auth: { persistSession: false, autoRefreshToken: false },
});
