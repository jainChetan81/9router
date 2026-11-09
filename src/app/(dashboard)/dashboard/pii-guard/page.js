import { Suspense } from "react";
import PiiGuardClient from "./PiiGuardClient";

export const dynamic = "force-dynamic";

export default function PiiGuardPage() {
  return <Suspense fallback={null}><PiiGuardClient /></Suspense>;
}
