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

type PosId = 1 | 2 | 3 | 4 | 5 | 6; // 1 GOL, 2 LAT, 3 ZAG, 4 MEI, 5 ATA, 6 TEC

const POS_LABEL: Record<number, string> = {
  1: "GOL",
  2: "LAT",
  3: "ZAG",
  4: "MEI",
  5: "ATA",
  6: "TEC",
};

const SCOUT_POINTS: Record<string, number> = {
  DS: 1.5,
  FC: -0.3,
  GC: -3.0,
  CA: -1.0,
  CV: -3.0,
  FS: 0.5,
  FT: 3.0,
  FD: 1.2,
  FF: 0.8,
  G: 8.0,
  I: -0.1,
  PP: -4.0,
  PC: -1.0,
  OS: 1.0,
  A: 5.0,
  SG: 5.0,
  DE: 1.3,
  DP: 7.0,
  GS: -1.0,
};

function isDefenderPosId(posId: number) {
  return posId === 1 || posId === 2 || posId === 3;
}
function isLinePosId(posId: number) {
  return posId === 2 || posId === 3 || posId === 4 || posId === 5; // exclui GOL e TEC
}

function makeRounds38() {
  return Array.from({ length: 38 }, (_, i) => i + 1);
}

function movingAvg(values: Array<number | null>, window = 3) {
  // média móvel "trailing": rodada i usa últimas 'window' rodadas com valor != null
  const out: Array<number | null> = [];
  for (let i = 0; i < values.length; i++) {
    const slice = values
      .slice(Math.max(0, i - window + 1), i + 1)
      .filter((v) => typeof v === "number") as number[];
    out.push(slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : null);
  }
  return out;
}

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
  if (!Number.isFinite(teamId) || teamId <= 0) {
    return NextResponse.json({ ok: false, error: "missing/invalid team_id" }, { status: 400 });
  }

  // filtros (vão afetar posição + SG + ofensiva)
  const isHomeParam = searchParams.get("is_home"); // "true" | "false" | null

  // 1) time
  const teamRes = await sb
    .from("fantasy_teams")
    .select("team_id, slug, name, cartoleiro_name, badge_url")
    .eq("team_id", teamId)
    .single();

  if (teamRes.error) {
    return NextResponse.json({ ok: false, error: "team not found (import first)" }, { status: 404 });
  }

  // 2) team_rounds
  const trRes = await sb
    .from("team_rounds")
    .select("id, round, points, patrimonio")
    .eq("team_id", teamId)
    .order("round", { ascending: true });

  if (trRes.error) {
    return NextResponse.json({ ok: false, error: trRes.error.message }, { status: 500 });
  }

  const teamRounds = trRes.data ?? [];
  const byRoundTR = new Map<number, { id: number; points: number | null; patrimonio: number | null }>();
  for (const r of teamRounds) {
    byRoundTR.set(Number(r.round), {
      id: Number(r.id),
      points: typeof r.points === "number" ? r.points : null,
      patrimonio: typeof r.patrimonio === "number" ? r.patrimonio : null,
    });
  }

  // totais
  const totalPoints = teamRounds.reduce((acc, r) => acc + (typeof r.points === "number" ? r.points : 0), 0);
  const patrimonioAtual =
    [...teamRounds]
      .reverse()
      .map((r) => (typeof r.patrimonio === "number" ? r.patrimonio : null))
      .find((v) => v != null) ?? null;

  // 3) picks (para métricas)
  // importante: para métricas, usamos rodadas importadas (team_rounds.id)
  const teamRoundIds = teamRounds.map((r) => r.id);

  let picksQuery = sb
    .from("picks")
    .select("team_round_id, position_id, position_name, atleta_id, atleta_name, club_id, points, is_captain, is_home, had_sg, had_goal, had_assist, scouts")
    .eq("team_id", teamId);

  if (teamRoundIds.length) picksQuery = picksQuery.in("team_round_id", teamRoundIds);
  if (isHomeParam === "true") picksQuery = picksQuery.eq("is_home", true);
  if (isHomeParam === "false") picksQuery = picksQuery.eq("is_home", false);

  const picksRes = await picksQuery;

  if (picksRes.error) {
    return NextResponse.json({ ok: false, error: picksRes.error.message }, { status: 500 });
  }

  const picks = (picksRes.data ?? []).map((p: any) => ({
    team_round_id: Number(p.team_round_id),
    position_id: Number(p.position_id),
    position_name: String(p.position_name ?? ""),
    atleta_id: Number(p.atleta_id),
    atleta_name: String(p.atleta_name ?? ""),
    club_id: p.club_id == null ? null : Number(p.club_id),
    points: typeof p.points === "number" ? (p.points as number) : null,
    is_captain: Boolean(p.is_captain),
    had_sg: Boolean(p.had_sg),
    had_goal: Boolean(p.had_goal),
    had_assist: Boolean(p.had_assist),
    scouts: p.scouts && typeof p.scouts === "object" ? p.scouts : null,
  }));

  // ---------
  // SÉRIES (38 rodadas)
  // ---------
  const rounds38 = makeRounds38();

  const pointsPerRound: Array<number | null> = rounds38.map((rd) => byRoundTR.get(rd)?.points ?? null);
  const pointsMA = movingAvg(pointsPerRound, 3);

  const pointsSeries = rounds38.map((rd, idx) => ({
    round: rd,
    points: pointsPerRound[idx],
    moving_avg: pointsMA[idx],
  }));

  const patrimonioSeries = rounds38.map((rd) => ({
    round: rd,
    patrimonio: byRoundTR.get(rd)?.patrimonio ?? null,
  }));

  // ---------
  // MÉDIA POR POSIÇÃO (ordenada por id) + CAP (linha extra)
  // ---------
  const posAgg: Record<number, { sum: number; cnt: number }> = {};
  let capSum = 0;
  let capCnt = 0;

  for (const p of picks) {
    if (!Number.isFinite(p.position_id) || p.position_id <= 0) continue;
    if (typeof p.points !== "number") continue;

    if (!posAgg[p.position_id]) posAgg[p.position_id] = { sum: 0, cnt: 0 };
    posAgg[p.position_id].sum += p.points;
    posAgg[p.position_id].cnt += 1;

    if (p.is_captain) {
      capSum += p.points;
      capCnt += 1;
    }
  }

  const avgByPos = [1, 2, 3, 4, 5, 6].map((posId) => {
    const a = posAgg[posId] ?? { sum: 0, cnt: 0 };
    return {
      position_id: posId,
      position: POS_LABEL[posId] ?? `POS_${posId}`,
      n: a.cnt,
      avg_points: a.cnt ? a.sum / a.cnt : null,
    };
  });

  // CAP como "posição extra" abaixo de TEC
  const capRow = {
    position_id: 99,
    position: "CAP",
    n: capCnt,
    avg_points: capCnt ? capSum / capCnt : null,
  };

  // ---------
  // SG (defensores) por posição + TOT
  // ---------
  const def = picks.filter((p) => isDefenderPosId(p.position_id));
  const sgByPos: Record<number, { ok: number; total: number }> = { 1: { ok: 0, total: 0 }, 2: { ok: 0, total: 0 }, 3: { ok: 0, total: 0 } };

  for (const p of def) {
    if (typeof p.points !== "number") {
      // mesmo sem points, ainda conta como pick (mas aqui seu dataset sempre tem points)
    }
    if (!sgByPos[p.position_id]) sgByPos[p.position_id] = { ok: 0, total: 0 };
    sgByPos[p.position_id].total += 1;
    if (p.had_sg) sgByPos[p.position_id].ok += 1;
  }

  const sgTotOk = def.filter((p) => p.had_sg).length;
  const sgTotN = def.length;

  const sgEfficiency = {
    by_position: [1, 2, 3].map((posId) => ({
      position_id: posId,
      position: POS_LABEL[posId],
      n: sgByPos[posId]?.total ?? 0,
      rate: sgByPos[posId]?.total ? (sgByPos[posId].ok / sgByPos[posId].total) : null,
    })),
    total: {
      position_id: 0,
      position: "TOT",
      n: sgTotN,
      rate: sgTotN ? sgTotOk / sgTotN : null,
    },
  };

  // ---------
  // OFENSIVA (linha) por posição + TOT
  // ---------
  const line = picks.filter((p) => isLinePosId(p.position_id));
  const offByPos: Record<number, { ok: number; total: number }> = {
    5: { ok: 0, total: 0 }, // ATA
    4: { ok: 0, total: 0 }, // MEI
    2: { ok: 0, total: 0 }, // LAT
    3: { ok: 0, total: 0 }, // ZAG
  };

  for (const p of line) {
    if (!offByPos[p.position_id]) offByPos[p.position_id] = { ok: 0, total: 0 };
    offByPos[p.position_id].total += 1;
    if (p.had_goal || p.had_assist) offByPos[p.position_id].ok += 1;
  }

  const offTotOk = line.filter((p) => p.had_goal || p.had_assist).length;
  const offTotN = line.length;

  const offensiveEfficiency = {
    by_position: [5, 4, 2, 3].map((posId) => ({
      position_id: posId,
      position: POS_LABEL[posId],
      n: offByPos[posId]?.total ?? 0,
      rate: offByPos[posId]?.total ? (offByPos[posId].ok / offByPos[posId].total) : null,
    })),
    total: {
      position_id: 0,
      position: "TOT",
      n: offTotN,
      rate: offTotN ? offTotOk / offTotN : null,
    },
  };

  // ---------
  // SUAS ESTRELAS (maior contribuição por posição)
  // ---------
  const starsAgg = new Map<string, {
    position_id: number;
    position: string;
    atleta_id: number;
    atleta_name: string;
    club_id: number | null;
    sum_points: number;
    n: number;
  }>();

  for (const p of picks) {
    if (![1, 2, 3, 4, 5, 6].includes(p.position_id)) continue;
    if (!Number.isFinite(p.atleta_id) || !p.atleta_name) continue;
    if (typeof p.points !== "number") continue;

    const key = `${p.position_id}:${p.atleta_id}`;
    const curr = starsAgg.get(key);

    if (!curr) {
      starsAgg.set(key, {
        position_id: p.position_id,
        position: POS_LABEL[p.position_id] ?? `POS_${p.position_id}`,
        atleta_id: p.atleta_id,
        atleta_name: p.atleta_name,
        club_id: p.club_id,
        sum_points: p.points,
        n: 1,
      });
      continue;
    }

    curr.sum_points += p.points;
    curr.n += 1;
    if (curr.club_id == null && p.club_id != null) curr.club_id = p.club_id;
  }

  const clubIds = Array.from(
    new Set(
      [...starsAgg.values()]
        .map((s) => s.club_id)
        .filter((v): v is number => typeof v === "number")
    )
  );

  const clubsMap = new Map<number, { badge_url: string | null }>();
  if (clubIds.length) {
    const clubsRes = await sb.from("clubs").select("*").in("id", clubIds);
    if (!clubsRes.error) {
      for (const c of clubsRes.data ?? []) {
        clubsMap.set(Number((c as any).id), { badge_url: pickBadge(c) });
      }
    }
  }

  const starsByPos = [1, 2, 3, 4, 5, 6].map((posId) => {
    const best = [...starsAgg.values()]
      .filter((s) => s.position_id === posId)
      .sort((a, b) => {
        if (b.sum_points !== a.sum_points) return b.sum_points - a.sum_points;
        const avgA = a.n ? a.sum_points / a.n : 0;
        const avgB = b.n ? b.sum_points / b.n : 0;
        if (avgB !== avgA) return avgB - avgA;
        return a.atleta_name.localeCompare(b.atleta_name);
      })[0];

    if (!best) {
      return {
        position_id: posId,
        position: POS_LABEL[posId],
        atleta_name: "—",
        club_badge_url: null,
        total_points: null,
        avg_points: null,
      };
    }

    return {
      position_id: posId,
      position: POS_LABEL[posId],
      atleta_name: best.atleta_name,
      club_badge_url: best.club_id != null ? (clubsMap.get(best.club_id)?.badge_url ?? null) : null,
      total_points: best.sum_points,
      avg_points: best.n ? best.sum_points / best.n : null,
    };
  });

  // ---------
  // PONTUAÇÃO POR SCOUT
  // ---------
  const scoutTotals = new Map<string, number>(
    Object.keys(SCOUT_POINTS).map((scout) => [scout, 0])
  );

  for (const p of picks) {
    const scouts = p.scouts;
    if (!scouts || typeof scouts !== "object") continue;

    for (const [scout, pointPerAction] of Object.entries(SCOUT_POINTS)) {
      const rawCount = (scouts as Record<string, unknown>)[scout];
      const count = typeof rawCount === "number" ? rawCount : Number(rawCount);
      if (!Number.isFinite(count)) continue;

      scoutTotals.set(scout, (scoutTotals.get(scout) ?? 0) + count * pointPerAction);
    }
  }

  const scoutPoints = Object.keys(SCOUT_POINTS)
    .map((scout) => ({
      scout,
      points: scoutTotals.get(scout) ?? 0,
    }))
    .filter(({ points }) => Math.abs(points) > 1e-9)
    .sort((a, b) => b.points - a.points);

  return NextResponse.json({
    ok: true,
    team_id: teamId,
    team: teamRes.data,
    filters: { is_home: isHomeParam },
    totals: {
      points_total: totalPoints,
      patrimonio_current: patrimonioAtual,
    },
    series: {
      points: pointsSeries,      // 38 rodadas: bar (points) + line (moving_avg)
      patrimonio: patrimonioSeries, // 38 rodadas: bar
    },
    metrics: {
      avg_points_by_position: [...avgByPos, capRow],
      points_by_scout: scoutPoints,
      sg_efficiency: sgEfficiency,
      offensive_efficiency: offensiveEfficiency,
      top_players_by_position: starsByPos,
    },
  });
}
