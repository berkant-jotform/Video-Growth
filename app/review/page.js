import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth.js";
import ReviewSessionPage from "@/components/ReviewSessionPage.jsx";

export default async function Page() {
  const session = await readSession();
  if (!session) redirect("/login");
  return <ReviewSessionPage session={session} />;
}
