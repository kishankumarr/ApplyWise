"use client";

import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { Button, toast } from "@applywise/ui";
import { api, errorMessage } from "@/lib/api";

export function DemoReset() {
  const router = useRouter();
  const reset = useMutation({
    mutationFn: () => api<{ demoJobs: number }>("/api/admin/demo-data", { body: {} }),
    onSuccess: (r) => {
      toast.success(`Re-seeded ${r.demoJobs} demo jobs.`);
      router.refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Button variant="outline" onClick={() => reset.mutate()} disabled={reset.isPending}>
      Re-seed demo jobs
    </Button>
  );
}
