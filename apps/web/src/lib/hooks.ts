"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { ProfileView } from "./client-types";

export function useProfile(opts: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: ["profile"],
    queryFn: () => api<ProfileView>("/api/profile"),
    refetchInterval: opts.poll ? 1000 : false,
  });
}

/** The value, updated only after it stopped changing for `ms` (search boxes: one request per pause, not per keystroke). */
export function useDebouncedValue<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
