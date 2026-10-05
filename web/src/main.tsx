import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { initTheme } from "./lib/theme";
import { meQuery, queryClient } from "./lib/queries";
import { router } from "./router";

initTheme();

// Une session expirée ou révoquée ailleurs : on oublie tout et on renvoie vers la connexion.
window.addEventListener("atelier:unauthorized", () => {
  queryClient.clear();
  queryClient.setQueryData(meQuery.queryKey, null);
  if (!location.pathname.startsWith("/login") && !location.pathname.startsWith("/invite"))
    router.navigate({ to: "/login", search: { redirect: location.pathname + location.search } });
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>
  </StrictMode>,
);
