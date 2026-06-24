import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth.js";
import SettingsPage from "@/components/SettingsPage.jsx";

export default async function Page() {
  const session = await readSession();
  if (!session) redirect("/login");
  return <SettingsPage session={session} />;
}
