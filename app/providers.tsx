"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

export default function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const host = process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://app.posthog.com";

    // Debug: mostra no console se as env vars chegaram
    console.log("[PostHog] init attempt", {
      hasKey: Boolean(key),
      host,
    });

    if (!key) return;

    posthog.init(key, {
      api_host: host,
      capture_pageview: false,
      autocapture: true,
    });

    // Força expor no window pra você conseguir testar
    (window as any).posthog = posthog;

    console.log("[PostHog] initialized");
  }, []);

  return <>{children}</>;
}
