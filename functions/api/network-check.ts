interface Env {
  // Add environment bindings here if needed
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const cf = context.request.cf;

  // Default response for local development or missing cf object
  if (!cf) {
    return new Response(
      JSON.stringify({
        isRisk: false,
        reason: null,
        details: "Local development or CF object missing",
        isp: "Local Dev",
        country: "CN", // Default to CN for local dev to avoid risk flag
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        },
      }
    );
  }

  const riskKeywords = [
    "google",
    "amazon",
    "aws",
    "microsoft",
    "azure",
    "digitalocean",
    "linode",
    "vultr",
    "alibaba",
    "tencent",
    "oracle",
    "cloudflare",
    "cdn",
    "server",
  ];

  const originalIsp = (cf.asOrganization as string) || "Unknown";
  const isp = originalIsp.toLowerCase();
  const country = (cf.country as string) || "Unknown";
  const threatScore = (cf.threatScore as number) || 0;

  let isRisk = false;
  let reason: "isp" | "score" | "location" | null = null;
  let details = "";

  // Condition A: ISP Check
  const isCloudProvider = riskKeywords.some((keyword) => isp.includes(keyword));

  if (isCloudProvider) {
    isRisk = true;
    reason = "isp";
    details = originalIsp;
  }
  // Condition B: Country Check (Non-CN)
  else if (country !== "CN") {
    isRisk = true;
    reason = "location";
    details = `Non-CN Location: ${country}`;
  }
  // Condition C: Threat Score Check
  else if (threatScore > 10) {
    isRisk = true;
    reason = "score";
    details = `Threat Score: ${threatScore}`;
  }

  return new Response(
    JSON.stringify({
      isRisk,
      reason,
      details,
      isp: originalIsp,
      country,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
      },
    }
  );
};
