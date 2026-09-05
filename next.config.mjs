/** @type {import('next').NextConfig} */
const nextConfig = {
  // bullmq/ioredis are Node-native queue clients used from API routes;
  // bundling them pulls in optional peer deps (e.g. @valkey/valkey-glide)
  // that don't exist and aren't needed, so leave them external instead.
  serverExternalPackages: ['bullmq', 'ioredis'],
};

export default nextConfig;
