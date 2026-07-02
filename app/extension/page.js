import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth.js";
import ExtensionPage from "@/components/ExtensionPage.jsx";

export default async function Page() {
  const session = await readSession();
  if (!session) redirect("/login");
  return <ExtensionPage session={session} />;
}
