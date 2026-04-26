import { NextRequest, NextResponse } from "next/server";
import { searchTracks } from "@/lib/spotify";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q");
  const limit = parseInt(
    request.nextUrl.searchParams.get("limit") ?? "10",
    10
  );

  if (!q?.trim()) {
    return NextResponse.json({ error: "Missing q parameter" }, { status: 400 });
  }

  try {
    const tracks = await searchTracks(q, Math.min(limit, 20));
    return NextResponse.json({ tracks });
  } catch {
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
