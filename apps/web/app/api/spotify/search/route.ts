import { NextRequest, NextResponse } from "next/server";
import { searchTracks } from "@/lib/spotify";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q");
  const rawLimit = request.nextUrl.searchParams.get("limit") ?? "10";
  const parsedLimit = Number.parseInt(rawLimit, 10);
  const limit = Number.isNaN(parsedLimit) ? 10 : Math.min(Math.max(parsedLimit, 1), 20);

  if (!q?.trim()) {
    return NextResponse.json({ error: "Missing q parameter" }, { status: 400 });
  }

  try {
    const tracks = await searchTracks(q.trim(), limit);
    return NextResponse.json({ tracks });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
