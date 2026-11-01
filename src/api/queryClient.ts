import { QueryClient } from "@tanstack/react-query";

/**
 * One client for the app. `refetchOnWindowFocus` is off on purpose: whether the window is
 * focused is shell state (a push), not a reason to refetch server data.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});
