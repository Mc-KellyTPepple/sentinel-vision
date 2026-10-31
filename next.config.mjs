/** @type {import('next').NextConfig} */

// Only this site may show the app inside an <iframe>, which protects against clickjacking.
// To allow another site, set ALLOWED_EMBED_ORIGINS (comma-separated origins) and redeploy.
const embedParents = (process.env.ALLOWED_EMBED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: ["frame-ancestors 'self'", ...embedParents].join(" ") },
          // The live camera feature needs the camera, only for this site's own pages.
          { key: "Permissions-Policy", value: "camera=(self), microphone=()" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
