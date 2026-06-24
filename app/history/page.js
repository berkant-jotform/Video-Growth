import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth.js";
import HistoryPage from "@/components/HistoryPage.jsx";

export default async function Page() {
  const session = await readSession();
  if (!session) redirect("/login");
  return <HistoryPage session={session} />;
}
