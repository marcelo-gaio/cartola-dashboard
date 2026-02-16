import { NextResponse } from "next/server";

export const runtime = "nodejs";

const BASE = "https://api.cartolafc.globo.com";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim();

  if (q.length < 2) return NextResponse.json({ teams: [] });

  const res = await fetch(`${BASE}/times?q=${encodeURIComponent(q)}`, { cache: "no-store" });
  if (!res.ok) return NextResponse.json({ teams: [], error: `HTTP ${res.status}` }, { status: 502 });

  const data = await res.json();
  const list: any[] = Array.isArray(data) ? data : (data?.times ?? data?.resultado ?? []);

  const teams = list
    .map((t: any) => ({
      id: t?.time_id ?? t?.id,  
      slug: t?.slug,
      name: t?.nome ?? t?.name,
      cartoleiro: t?.nome_cartola ?? null,
      badge_url: t?.url_escudo_png ?? t?.url_escudo_svg ?? t?.escudos?.["60x60"] ?? null,
    }))
    .filter((t) => t.slug && t.name);

  return NextResponse.json({ teams });
}
