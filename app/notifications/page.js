import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth.js";
import NotificationsPage from "@/components/NotificationsPage.jsx";

export default async function Page() {
  const session = await readSession();
  if (!session) redirect("/login");
  return <NotificationsPage session={session} />;
}
