import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth.js";
import UploadsPage from "@/components/UploadsPage.jsx";

export default async function Page() {
  const session = await readSession();
  if (!session) redirect("/login");
  return <UploadsPage session={session} />;
}
