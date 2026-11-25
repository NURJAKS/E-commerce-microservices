import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['apps/**/*.spec.ts', 'libs/**/*.spec.ts'],
    exclude: ['**/*.integration.spec.ts', '**/node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [
        'apps/order-service/src/order.service.ts',
        'apps/order-service/src/cart.service.ts',
        'apps/auth-service/src/auth.service.ts',
        'apps/api-gateway/src/security-redis.service.ts',
        'apps/api-gateway/src/guards/*.ts',
        'apps/api-gateway/src/interceptors/*.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
  resolve: {
    alias: {
      '@shop/contracts': path.resolve(__dirname, 'libs/contracts/src/index.ts'),
      '@shop/rmq': path.resolve(__dirname, 'libs/rmq/src/index.ts'),
      '@shop/common': path.resolve(__dirname, 'libs/common/src/index.ts'),
      '@prisma/auth-client': path.resolve(
        __dirname,
        'node_modules/.prisma/auth-client',
      ),
      '@prisma/catalog-client': path.resolve(
        __dirname,
        'node_modules/.prisma/catalog-client',
      ),
      '@prisma/order-client': path.resolve(
        __dirname,
        'node_modules/.prisma/order-client',
      ),
      '@prisma/payment-client': path.resolve(
        __dirname,
        'node_modules/.prisma/payment-client',
      ),
    },
  },
});
