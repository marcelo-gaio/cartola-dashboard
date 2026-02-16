import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const BASE = "https://api.cartolafc.globo.com";

function supabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

async function fetchJson(url: string) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.json();
}

export async function POST() {
  const sb = supabase();

  // 1) Clubes
  const clubes = await fetchJson(`${BASE}/clubes`);
  const clubesArr = Object.values<any>(clubes ?? {}).map((c: any) => ({
    id: c.id,
    name: c.nome,
    abbr: c.abreviacao,
    badge_60: c.escudos?.["60x60"] ?? null,
    badge_45: c.escudos?.["45x45"] ?? null,
    badge_30: c.escudos?.["30x30"] ?? null,
    updated_at: new Date().toISOString(),
  }));

  if (clubesArr.length) {
    await sb.from("clubs").upsert(clubesArr, { onConflict: "id" });
  }

  // 2) Rodadas
  const rodadas = await fetchJson(`${BASE}/rodadas`);
  const roundsArr = (Array.isArray(rodadas) ? rodadas : [])
    .map((r: any) => ({
      round: Number(r.rodada_id ?? r.rodada ?? r.numero),
      status: r.status ?? null,
      start_at: r.inicio ? new Date(r.inicio).toISOString() : null,
      end_at: r.fim ? new Date(r.fim).toISOString() : null,
      updated_at: new Date().toISOString(),
    }))
    .filter((x: any) => Number.isFinite(x.round) && x.round > 0);

  if (roundsArr.length) {
    await sb.from("rounds").upsert(roundsArr, { onConflict: "round" });
  }

  // 3) Partidas por rodada
  let matchesUpserted = 0;

  for (const r of roundsArr) {
    const partidas = await fetchJson(`${BASE}/partidas/${r.round}`);
    const jogos = partidas?.partidas ?? [];

    const matchesArr = jogos.map((m: any) => ({
      round: r.round,
      home_club_id: m.clube_casa_id,
      away_club_id: m.clube_visitante_id,
      home_score: m.placar_oficial_mandante ?? null,
      away_score: m.placar_oficial_visitante ?? null,
      match_date: m.partida_data ? new Date(m.partida_data).toISOString() : null,
      updated_at: new Date().toISOString(),
    }));

    if (matchesArr.length) {
      const res = await sb.from("matches").upsert(matchesArr, {
        onConflict: "round,home_club_id,away_club_id",
      });
      if (!res.error) matchesUpserted += matchesArr.length;
    }
  }

  return NextResponse.json({
    clubs: clubesArr.length,
    rounds: roundsArr.length,
    matches_upserted: matchesUpserted,
  });
}