/** @type {import('next').NextConfig} */
const nextConfig = {
    // Lint runs during `next build`. It only fails the build on ESLint *errors*
    // (warnings are allowed), so real mistakes are caught in CI/deploys.
    eslint: {
        ignoreDuringBuilds: false,
    },
};

export default nextConfig;
