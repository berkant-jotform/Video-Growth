import { NextResponse } from "next/server";

export function json(data, init = {}) {
  return NextResponse.json(data, init);
}

export function errorJson(error) {
  const status = error?.status || 500;
  return json(
    {
      ok: false,
      error: error?.message || "Unexpected error",
      type: error?.name || "Error",
      ...(error?.activeScan ? { activeScan: error.activeScan } : {})
    },
    { status }
  );
}

export function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}
