import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

export async function GET() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  if (!url || !key) {
    return NextResponse.json(
      { ok: false, error: "Variáveis de ambiente não encontradas" },
      { status: 500 }
    );
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabase.from("clubs").select("id").limit(1);

  return NextResponse.json({
    ok: !error,
    supabaseConnected: !error,
    sampleRows: data?.length ?? 0,
    error: error?.message ?? null,
  });
}
