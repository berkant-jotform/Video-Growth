import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth.js";
import DetectorPage from "@/components/DetectorPage.jsx";

export default async function Page() {
  const session = await readSession();
  if (!session) redirect("/login");
  return <DetectorPage session={session} />;
}
