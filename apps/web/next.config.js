/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["wavesurfer.js"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "i.scdn.co" },
      { protocol: "https", hostname: "*.spotifycdn.com" },
      { protocol: "https", hostname: "mosaic.scdn.co" },
    ],
  },
};

module.exports = nextConfig;
