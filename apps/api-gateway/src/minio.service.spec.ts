import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MinioService, PRESIGN_EXPIRES_IN_SECONDS } from './minio.service';

describe('MinioService — Direct-to-MinIO Presigned PUT URLs', () => {
  let minioService: MinioService;

  beforeEach(() => {
    process.env.MINIO_ENDPOINT = 'http://minio:9000';
    process.env.MINIO_PUBLIC_URL = 'http://localhost:9000';
    process.env.MINIO_BUCKET = 'products-media';
    process.env.MINIO_ACCESS_KEY = 'minioadmin';
    process.env.MINIO_SECRET_KEY = 'minioadmin';

    minioService = new MinioService();
    vi.spyOn(minioService as any, 'ensureBucketExists').mockResolvedValue(
      undefined,
    );
  });

  it('generates a 60-second SigV4 presigned PUT URL signed for the public MinIO host', async () => {
    const res = await minioService.createPresignedUploadUrl({
      fileName: '../../evil-path/keyboard.webp',
      contentType: 'image/webp',
      sizeBytes: 128_000,
    });

    expect(res.expiresInSeconds).toBe(PRESIGN_EXPIRES_IN_SECONDS);
    expect(res.key).toMatch(/^products\/product-\d+-[a-f0-9]+\.webp$/);
    expect(res.publicUrl).toBe(`http://localhost:9000/products-media/${res.key}`);
    expect(res.uploadUrl).toContain('http://localhost:9000/products-media/');
    expect(res.uploadUrl).toContain('X-Amz-Signature=');
    expect(res.uploadUrl).toContain('X-Amz-Expires=60');
    expect(res.requiredHeaders).toEqual({ 'Content-Type': 'image/webp' });
  });

  it('rejects unsupported MIME types and oversized uploads', async () => {
    await expect(
      minioService.createPresignedUploadUrl({
        fileName: 'exploit.svg',
        contentType: 'image/svg+xml',
        sizeBytes: 1024,
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      minioService.createPresignedUploadUrl({
        fileName: 'huge.png',
        contentType: 'image/png',
        sizeBytes: 25 * 1024 * 1024,
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
