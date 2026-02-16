import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function supabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

const POS_TO_ID: Record<string, number> = { GOL: 1, LAT: 2, ZAG: 3, MEI: 4, ATA: 5, TEC: 6 };

function pickBadge(row: any): string | null {
  return (
    row?.badge_60 ??
    row?.badge_45 ??
    row?.badge_30 ??
    row?.badge_url ??
    row?.escudo_png ??
    row?.escudo_svg ??
    row?.url_escudo_png ??
    row?.url_escudo_svg ??
    row?.shield_url ??
    row?.shield_png ??
    row?.shield_svg ??
    null
  );
}

export async function GET(req: Request) {
  const sb = supabase();
  const { searchParams } = new URL(req.url);

  const teamId = Number(searchParams.get("team_id"));
  const pos = String(searchParams.get("pos") ?? "TOT").toUpperCase();
  const isHome = searchParams.get("is_home"); // "true"|"false"|null

  if (!Number.isFinite(teamId) || teamId <= 0) {
    return NextResponse.json({ ok: false, error: "missing/invalid team_id" }, { status: 400 });
  }

  // posições aceitas: ATA/MEI/LAT/ZAG/TOT
  const posId = pos === "TOT" ? null : (POS_TO_ID[pos] ?? null);
  const allowed = new Set([2, 3, 4, 5]); // LAT, ZAG, MEI, ATA
  if (pos !== "TOT" && (!posId || !allowed.has(posId))) {
    return NextResponse.json({ ok: false, error: "invalid pos (use ATA|MEI|LAT|ZAG|TOT)" }, { status: 400 });
  }

  let q = sb
    .from("picks")
    .select("atleta_name, club_id, points, had_goal, had_assist, position_id, is_home, team_rounds(round)")
    .eq("team_id", teamId)
    .in("position_id", [2, 3, 4, 5]);

  if (posId) q = q.eq("position_id", posId);
  if (isHome === "true") q = q.eq("is_home", true);
  if (isHome === "false") q = q.eq("is_home", false);

  const picksRes = await q;

  if (picksRes.error) {
    return NextResponse.json({ ok: false, error: picksRes.error.message }, { status: 500 });
  }

  const rowsRaw = (picksRes.data ?? []).map((r: any) => ({
    round: Number(r.team_rounds?.round),
    atleta_name: String(r.atleta_name ?? ""),
    club_id: r.club_id == null ? null : Number(r.club_id),
    points: typeof r.points === "number" ? (r.points as number) : null,
    ok: Boolean(r.had_goal || r.had_assist),
  }));

  const clubIds = Array.from(
    new Set(rowsRaw.map((r) => r.club_id).filter((v): v is number => typeof v === "number"))
  );

  const clubsMap = new Map<number, { name: string; badge_url: string | null }>();

  if (clubIds.length) {
    const clubsRes = await sb.from("clubs").select("*").in("id", clubIds);
    if (!clubsRes.error) {
      for (const c of clubsRes.data ?? []) {
        clubsMap.set(Number((c as any).id), {
          name: String((c as any).name ?? (c as any).nome ?? ""),
          badge_url: pickBadge(c),
        });
      }
    }
  }

  const rows = rowsRaw
    .map((r) => {
      const c = r.club_id != null ? clubsMap.get(r.club_id) : null;
      return {
        ...r,
        club_name: c?.name || "—",
        club_badge_url: c?.badge_url ?? null,
      };
    })
    .sort((a, b) => a.round - b.round);

  return NextResponse.json({ ok: true, team_id: teamId, pos, rows });
}
